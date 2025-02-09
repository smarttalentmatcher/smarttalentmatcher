//
// server.js
//
const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const juice = require("juice");
const cors = require("cors");
const mongoose = require("mongoose"); // MongoDB 사용

// 1) MongoDB 연결
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
  });

// 2) Express 앱 생성
const app = express();

// 동적 포트 (Render 등 호스팅 고려)
const PORT = process.env.PORT || 3000;

// 요청 로그 (디버깅용)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

/** 날짜 기반 오더ID 생성 (MMDDHHmm) 예: "09182010" */
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

// JSON 파일에 저장할 임시 데이터 (기존 코드 유지)
const DATA_FILE = path.join(__dirname, "ordersData.json");
let draftOrders = [];
let finalOrders = [];

/** 서버 시작 시 주문 데이터 불러오기 */
function loadOrdersData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        draftOrders = parsed.draftOrders || [];
        finalOrders = parsed.finalOrders || [];
      }
      console.log("✅ Loaded orders data from", DATA_FILE);
    } catch (err) {
      console.error("Failed to parse ordersData.json:", err);
    }
  } else {
    console.log("No existing data file found. Starting fresh.");
  }
}
loadOrdersData();

function saveOrdersData() {
  const dataToSave = { draftOrders, finalOrders };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), "utf-8");
    console.log("✅ Orders data saved to", DATA_FILE);
  } catch (err) {
    console.error("Failed to save orders data:", err);
  }
}

// Multer 설정
const upload = multer({ dest: "uploads/" });
const uploadResume = multer({ dest: "uploads/resume/" });

// 정적 파일
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// JSON, URL-encoded 파싱
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(cors());

// Nodemailer (네이버 SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.naver.com",
  port: 465,
  secure: true,
  auth: {
    user: "letsspeak01@naver.com", // 본인 계정
    pass: "ESLUTHE53P6L"           // 앱 비밀번호 또는 실제 비밀번호
  }
});

// 자동 정리 (ordersData.json & uploads 폴더)
function cleanUpOrdersData() {
  const dataToSave = { finalOrders: finalOrders };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), "utf-8");
    console.log("✅ Orders data cleaned up in", DATA_FILE);
  } catch (err) {
    console.error("Failed to clean orders data:", err);
  }
}

function cleanUpUnusedUploads() {
  const usedFiles = new Set();
  finalOrders.forEach(order => {
    if (order.headshot) {
      usedFiles.add(path.join(__dirname, order.headshot));
    }
  });

  function cleanDirectory(directory) {
    fs.readdir(directory, (err, files) => {
      if (err) {
        console.error("Error reading directory", directory, err);
        return;
      }
      files.forEach(file => {
        const filePath = path.join(directory, file);
        fs.stat(filePath, (err, stats) => {
          if (err) {
            console.error("Error getting stats for", filePath, err);
            return;
          }
          if (stats.isDirectory()) {
            cleanDirectory(filePath);
          } else {
            if (!usedFiles.has(filePath)) {
              fs.unlink(filePath, err => {
                if (err) {
                  console.error("Error deleting file", filePath, err);
                } else {
                  console.log("🗑 Deleted unused file:", filePath);
                }
              });
            }
          }
        });
      });
    });
  }
  const uploadsDir = path.join(__dirname, "uploads");
  cleanDirectory(uploadsDir);
}
setInterval(() => {
  cleanUpOrdersData();
  cleanUpUnusedUploads();
}, 60 * 60 * 1000);
cleanUpOrdersData();
cleanUpUnusedUploads();

// 12h/24h 타이머
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const reminderTimers = {};
const autoCancelTimers = {};

function scheduleReminder(order) {
  const timeLeft = order.createdAt + TWELVE_HOURS - Date.now();
  if (timeLeft > 0 && !order.paid && !order.reminderSent) {
    if (reminderTimers[order.orderId]) {
      clearTimeout(reminderTimers[order.orderId]);
      delete reminderTimers[order.orderId];
    }
    const timeoutId = setTimeout(() => sendReminder(order), timeLeft);
    reminderTimers[order.orderId] = timeoutId;
    console.log(`⏰ Scheduled 12h reminder for #${order.orderId} in ${Math.round(timeLeft/1000)}s`);
  }
}

function scheduleAutoCancel(order) {
  const timeLeft = order.createdAt + TWENTY_FOUR_HOURS - Date.now();
  if (timeLeft > 0 && !order.paid) {
    if (autoCancelTimers[order.orderId]) {
      clearTimeout(autoCancelTimers[order.orderId]);
      delete autoCancelTimers[order.orderId];
    }
    const timeoutId = setTimeout(() => autoCancelOrder(order), timeLeft);
    autoCancelTimers[order.orderId] = timeoutId;
    console.log(`⏰ Scheduled 24h auto-cancel for #${order.orderId} in ${Math.round(timeLeft/1000)}s`);
  }
}

function sendReminder(order) {
  if (order.paid || order.reminderSent) return;

  // Admin에 저장된 invoice를 사용하도록 변경
  const savedOrder = finalOrders.find(o => o.orderId === order.orderId);
  if (!savedOrder) {
    console.error(`❌ Order #${order.orderId} not found in finalOrders.`);
    return;
  }

  // email.html 템플릿 읽기
  const templatePath = path.join(__dirname, "email.html");
  let reminderEmailHtml = "";

  if (fs.existsSync(templatePath)) {
    reminderEmailHtml = fs.readFileSync(templatePath, "utf-8");
  } else {
    reminderEmailHtml = "<html><body><p>Invoice details not available.</p></body></html>";
  }

  // Admin에 저장된 invoice 값으로 email.html의 {{invoice}} 치환
  reminderEmailHtml = reminderEmailHtml.replace(/{{\s*invoice\s*}}/g, savedOrder.invoice);

  const mailOptions = {
    from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
    to: savedOrder.emailAddress,
    subject: "**Reminder** [Smart Talent Matcher] Invoice for Your Submission",
    html: reminderEmailHtml
  };

  transporter.sendMail(mailOptions)
    .then(info => {
      console.log(`✅ Reminder email sent for #${order.orderId}:`, info.response);
      order.reminderSent = true;
      saveOrdersData();
    })
    .catch(err => {
      console.error("❌ Error sending reminder:", err);
    });
}

function autoCancelOrder(order) {
  if (order.paid) return;
  const cancelHtml = `
    <div style="font-family: Arial, sans-serif;">
      <p>Hello,</p>
      <p>Your invoice (Order #${order.orderId}) has been <strong>canceled</strong> (24h passed).</p>
      <br>
      <p>Regards,<br>Smart Talent Matcher</p>
    </div>
  `;
  const mailOptions = {
    from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
    to: order.emailAddress,
    subject: "[Smart Talent Matcher] Invoice Auto-Canceled (24h Passed)",
    html: cancelHtml
  };
  transporter.sendMail(mailOptions)
    .then(info => {
      console.log(`🚨 Auto-cancel email sent for #${order.orderId}:`, info.response);
      finalOrders = finalOrders.filter(o => o.orderId !== order.orderId);
      saveOrdersData();
    })
    .catch(err => {
      console.error("❌ Error sending auto-cancel:", err);
    });
}

// ──────────────────────────────────────────────
// 라우트
// ──────────────────────────────────────────────

// 메인 "/" → resume.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

// Test email - Headshot → Reel → Resume → Intro
const uploadHeadshot = multer({ dest: "uploads/" });
app.post("/send-test-email", uploadHeadshot.single("headshot"), async (req, res) => {
  try {
    const { emailAddress, emailSubject, actingReel, resumeLink, introduction } = req.body;
    const formattedIntro = introduction ? introduction.replace(/\r?\n/g, "<br>") : "";
    let emailHtml = `<div style="font-family: Arial, sans-serif;">`;
    if (req.file) {
      emailHtml += `
        <div>
          <img src="cid:headshotImage" style="max-width:600px; width:100%; height:auto;" />
        </div>
        <br>
      `;
    }
    emailHtml += `
      <p><strong>Acting Reel:</strong> <a href="${actingReel}" target="_blank">${actingReel}</a></p>
      <p><strong>Resume:</strong> <a href="${resumeLink}" target="_blank">${resumeLink}</a></p>
      <br>
      <p>${formattedIntro}</p>
    `;
    emailHtml += `</div>`;

    const mailOptions = {
      from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
      to: emailAddress,
      subject: emailSubject,
      html: emailHtml,
      attachments: req.file
        ? [{
            filename: req.file.originalname,
            path: req.file.path,
            cid: "headshotImage"
          }]
        : []
    };
    console.log("Sending test email to:", emailAddress);
    const info = await transporter.sendMail(mailOptions);
    console.log("Test Email sent:", info.response);
    res.json({ success: true, message: "Test email sent successfully!" });
  } catch (error) {
    console.error("Error sending test email:", error);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

/** (A) /submit-order → choose.html (드래프트 주문 생성) */
app.post("/submit-order", (req, res) => {
  try {
    const {
      emailAddress,
      invoice,
      subtotal,
      baseDiscount,
      promoDiscount,
      finalCost
    } = req.body;

    const orderId = generateDateTimeOrderId();
    const createdAt = Date.now();

    // NaN 방지
    const cleanSubtotal = isNaN(parseFloat(subtotal)) ? 0 : parseFloat(subtotal);
    const cleanBaseDiscount = isNaN(parseFloat(baseDiscount)) ? 0 : parseFloat(baseDiscount);
    const cleanPromoDiscount = isNaN(parseFloat(promoDiscount)) ? 0 : parseFloat(promoDiscount);
    const cleanFinalCost = isNaN(parseFloat(finalCost)) ? 0 : parseFloat(finalCost);

    // invoice가 비어있으면 기본 메시지
    const invoiceData = invoice && invoice.trim() !== ""
      ? invoice
      : "<p>Invoice details not available.</p>";

    const newDraft = {
      orderId,
      emailAddress: emailAddress || "",
      invoice: invoiceData,
      subtotal: cleanSubtotal,
      baseDiscount: cleanBaseDiscount,
      promoDiscount: cleanPromoDiscount,
      finalCost: cleanFinalCost,
      createdAt
    };

    draftOrders.push(newDraft);
    console.log("✅ Draft order received:", newDraft);
    saveOrdersData();

    res.json({
      success: true,
      message: "Draft order received (without email template)",
      orderId
    });
  } catch (err) {
    console.error("Error in /submit-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

/** (B) /update-order → resume.html (파일 업로드, draft 갱신) */
app.post("/update-order", uploadResume.single("headshot"), (req, res) => {
  console.log("Update order request body:", req.body);
  const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice } = req.body;
  const existingOrder = draftOrders.find(o => o.orderId === orderId);

  if (!existingOrder) {
    console.error("Draft order not found for orderId:", orderId);
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  if (emailAddress !== undefined) existingOrder.emailAddress = emailAddress;
  if (emailSubject !== undefined) existingOrder.emailSubject = emailSubject;
  if (actingReel !== undefined) existingOrder.actingReel = actingReel;
  if (resumeLink !== undefined) existingOrder.resumeLink = resumeLink;
  if (introduction !== undefined) existingOrder.introduction = introduction;

  // 필요하다면 invoice도 업데이트
  // if (invoice) existingOrder.invoice = invoice;

  if (req.file) {
    existingOrder.headshot = `/uploads/resume/${req.file.filename}`;
  }

  console.log("✅ Draft order updated:", existingOrder);
  saveOrdersData();

  res.json({
    success: true,
    message: "Draft order updated",
    updatedOrder: existingOrder
  });
});

/** (C) /final-submit → submit.html (최종 제출) */
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log("Final submit received:", req.body);

    // 기존 최종 주문(이메일 기준) 취소
    const oldFinals = finalOrders.filter(o => o.emailAddress === emailAddress);
    if (oldFinals.length > 0) {
      console.log(`Found ${oldFinals.length} old final orders for ${emailAddress}. Canceling them...`);
      for (const oldOrder of oldFinals) {
        const cancelHtml = `
          <div style="font-family: Arial, sans-serif;">
            <p>Hello,</p>
            <p>Your older invoice (Order #${oldOrder.orderId}) has been <strong>canceled</strong>.</p>
            <p>Only the new invoice will remain valid. If you have any questions, please contact us.</p>
            <br>
            <p>Regards,<br>Smart Talent Matcher</p>
          </div>
        `;
        await transporter.sendMail({
          from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
          to: emailAddress,
          subject: "[Smart Talent Matcher] Previous Invoice Canceled",
          html: cancelHtml
        });
        console.log(`Cancellation email sent for old order #${oldOrder.orderId}.`);

        if (reminderTimers[oldOrder.orderId]) {
          clearTimeout(reminderTimers[oldOrder.orderId]);
          delete reminderTimers[oldOrder.orderId];
        }
        if (autoCancelTimers[oldOrder.orderId]) {
          clearTimeout(autoCancelTimers[oldOrder.orderId]);
          delete autoCancelTimers[oldOrder.orderId];
        }
      }
      finalOrders = finalOrders.filter(o => o.emailAddress !== emailAddress);
    }

    const existingDraft = draftOrders.find(o => o.orderId === orderId);
    if (existingDraft && invoice) {
      existingDraft.invoice = invoice;
    }

    // 새 파이널 ID 생성
    const newFinalOrderId = generateDateTimeOrderId();
    const finalInvoice = (existingDraft && existingDraft.invoice)
      ? existingDraft.invoice
      : (invoice || "<p>Invoice details not available.</p>");

    // 최종 오더
    const newFinal = {
      orderId: newFinalOrderId,
      emailAddress: emailAddress || "",
      emailSubject: emailSubject || "",
      actingReel: actingReel || "",
      resumeLink: resumeLink || "",
      introduction: introduction || "",
      invoice: finalInvoice,
      venmoId: venmoId || "",
      createdAt: Date.now(),
      paid: false,
      reminderSent: false
    };
    if (existingDraft && existingDraft.headshot) {
      newFinal.headshot = existingDraft.headshot;
    }
    finalOrders.push(newFinal);
    console.log("✅ Final submission order saved:", newFinal);
    saveOrdersData();

    // (1) 관리자 이메일 발송
    const formattedIntro = introduction ? introduction.replace(/\r?\n/g, "<br>") : "";
    let adminEmailHtml = `<div style="font-family: Arial, sans-serif;">`;
    if (existingDraft && existingDraft.headshot) {
      adminEmailHtml += `
        <div>
          <img src="cid:headshotImage" style="max-width:600px; width:100%; height:auto;" />
        </div>
        <br>
      `;
    }
    adminEmailHtml += `
      <p><strong>Acting Reel:</strong> <a href="${actingReel}" target="_blank">${actingReel}</a></p>
      <p><strong>Resume:</strong> <a href="${resumeLink}" target="_blank">${resumeLink}</a></p>
      <br>
      <p>${formattedIntro}</p>
    `;
    adminEmailHtml += `</div>`;
    const adminMailOptions = {
      from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
      to: "letsspeak01@naver.com",
      subject: emailSubject || "[No Subject Provided]",
      html: adminEmailHtml,
      attachments: (existingDraft && existingDraft.headshot)
        ? [{
            filename: path.basename(existingDraft.headshot),
            path: path.join(__dirname, existingDraft.headshot),
            cid: "headshotImage"
          }]
        : []
    };
    const adminInfo = await transporter.sendMail(adminMailOptions);
    console.log("✅ Admin email sent:", adminInfo.response);

    // 4️⃣ 클라이언트 Invoice 이메일 전송
    const savedOrder = finalOrders.find(o => o.orderId === newFinalOrderId);
    if (!savedOrder) {
      throw new Error("Failed to retrieve saved order for email.");
    }

    // email.html 템플릿
    const templatePath = path.join(__dirname, "email.html");
    let emailHtml = "";
    if (fs.existsSync(templatePath)) {
      emailHtml = fs.readFileSync(templatePath, "utf-8");
    } else {
      emailHtml = "<html><body><p>Invoice details not available.</p></body></html>";
    }

    // invoice 치환
    emailHtml = emailHtml.replace(/{{\s*invoice\s*}}/g, savedOrder.invoice);

    await transporter.sendMail({
      from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
      to: savedOrder.emailAddress,
      subject: "[Smart Talent Matcher] Invoice for Your Submission",
      html: emailHtml
    });
    console.log("✅ Client Invoice email sent.");

    // (3) 타이머 등록
    scheduleReminder(newFinal);
    scheduleAutoCancel(newFinal);

    res.json({
      success: true,
      message: "Final submission complete! Emails sent and timers set."
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

/** 관리자 주문 조회 */
app.get("/admin/orders", (req, res) => {
  const processedOrders = finalOrders.map(order => {
    const expired = (!order.paid && (Date.now() - order.createdAt >= 24 * 60 * 60 * 1000));
    return { ...order, expired };
  });
  res.json(processedOrders);
});

// 삭제
app.post("/admin/delete-order", (req, res) => {
  const { orderId } = req.body;
  const idx = finalOrders.findIndex(o => o.orderId === orderId);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  const targetOrder = finalOrders[idx];
  const emailAddress = targetOrder.emailAddress;
  const cancelHtml = `
    <div style="font-family: Arial, sans-serif;">
      <p>Hello,</p>
      <p>Your invoice (Order #${targetOrder.orderId}) has been <strong>canceled</strong> by the admin.</p>
      <br>
      <p>Regards,<br>Smart Talent Matcher</p>
    </div>
  `;
  const cancelOptions = {
    from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
    to: emailAddress,
    subject: "[Smart Talent Matcher] Invoice Canceled (Admin)",
    html: cancelHtml
  };
  transporter.sendMail(cancelOptions)
    .then(info => {
      console.log("✅ Cancel email sent:", info.response);

      if (reminderTimers[orderId]) {
        clearTimeout(reminderTimers[orderId]);
        delete reminderTimers[orderId];
      }
      if (autoCancelTimers[orderId]) {
        clearTimeout(autoCancelTimers[orderId]);
        delete autoCancelTimers[orderId];
      }
      finalOrders.splice(idx, 1);
      saveOrdersData();

      res.json({ success: true, message: `Order #${orderId} deleted. Cancel email sent.` });
    })
    .catch(err => {
      console.error("❌ Error sending cancel email:", err);
      res.status(500).json({ success: false, message: "Failed to send cancel email" });
    });
});

// 결제 상태 업데이트
app.post("/admin/update-payment", (req, res) => {
  const { orderId, paid } = req.body;
  const order = finalOrders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  order.paid = Boolean(paid);
  console.log(`Order #${orderId} payment status updated to ${order.paid}`);
  saveOrdersData();
  res.json({ success: true, message: "Payment status updated." });
});

// 3) 서버 실행
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);

  // 기존 오더에 대해 리마인더 / 오토캔슬 스케줄
  finalOrders.forEach(order => {
    scheduleReminder(order);
    scheduleAutoCancel(order);
  });
});

/** [추가] 테스트용 스키마 & 라우트 (Mongo 연결 확인용) */
const testSchema = new mongoose.Schema({
  testField: String
});
const TestModel = mongoose.model("TestModel", testSchema);

app.get("/test-mongo", async (req, res) => {
  try {
    const doc = await TestModel.create({ testField: "Hello Mongo!" });
    res.json({ success: true, doc });
  } catch (err) {
    console.error("DB Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});