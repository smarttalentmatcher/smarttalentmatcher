//
// server.js
//
const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const juice = require("juice");
const cors = require("cors"); // CORS 모듈 추가

const app = express();
const PORT = 3000;

/** 날짜 기반 오더ID (MMDDHHmm). 예: "09182010" */
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

const DATA_FILE = path.join(__dirname, "ordersData.json");
let draftOrders = [];
let finalOrders = [];

/** 서버 시작 시 파일 불러오기 */
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

function saveOrdersData() {
  const dataToSave = { draftOrders, finalOrders };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), "utf-8");
    console.log("✅ Orders data saved to", DATA_FILE);
  } catch (err) {
    console.error("Failed to save orders data:", err);
  }
}
loadOrdersData();

// Multer 설정
const upload = multer({ dest: "uploads/" });
const uploadResume = multer({ dest: "uploads/resume/" });

// 정적 파일 제공: 모든 파일이 최상위에 있으므로 __dirname에서 제공
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 설정 (모든 도메인 허용)
app.use(cors());

// Nodemailer 설정 (네이버 SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.naver.com",
  port: 465,
  secure: true,
  auth: {
    user: "letsspeak01@naver.com",  // 본인 계정
    pass: "ESLUTHE53P6L"            // 앱 비밀번호 또는 실제 비밀번호
  }
});

// ──────────────────────────────────────────────
// 자동 정리 기능: ordersData.json 및 uploads 폴더 정리 (재귀적)
// ──────────────────────────────────────────────

// ordersData.json 정리: 어드민에 보이는 주문(finalOrders)만 남김
function cleanUpOrdersData() {
  const dataToSave = { finalOrders: finalOrders };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), "utf-8");
    console.log("✅ Orders data cleaned up in", DATA_FILE);
  } catch (err) {
    console.error("Failed to clean orders data:", err);
  }
}

// uploads 폴더 정리 (재귀적): ordersData.json에 사용되지 않는 파일 삭제
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
}, 60 * 60 * 1000); // 1시간마다 실행

cleanUpOrdersData();
cleanUpUnusedUploads();

// 타이머 설정 (12h / 24h)
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const reminderTimers = {};
const autoCancelTimers = {};

/** 리마인드 타이머 등록 */
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

/** 자동취소 타이머 등록 */
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

/** 리마인드 이메일 발송 */
function sendReminder(order) {
  if (order.paid || order.reminderSent) return;
  const templatePath = path.join(__dirname, "email.html");
  let reminderEmailHtml = "";
  if (fs.existsSync(templatePath)) {
    reminderEmailHtml = fs.readFileSync(templatePath, "utf-8");
  } else {
    reminderEmailHtml = `<html><body><p>Invoice details not available.</p></body></html>`;
  }
  reminderEmailHtml = juice(reminderEmailHtml);
  const invoiceHtml = order.invoice || "<p>Invoice details not available.</p>";
  reminderEmailHtml = reminderEmailHtml.replace(/{{\s*invoice\s*}}/g, invoiceHtml);
  const mailOptions = {
    from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
    to: order.emailAddress,
    subject: "**Reminder**[Smart Talent Matcher] Invoice for Your Submission",
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

/** 자동취소 이메일 발송 */
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
// 라우트 설정
// ──────────────────────────────────────────────

// 테스트 페이지 (resume.html) 제공
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
    `;
    emailHtml += `<p>${formattedIntro}</p>`;
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

/** (A) /submit-order -> choose.html (드래프트 주문 생성) */
app.post("/submit-order", (req, res) => {
  try {
    const { emailAddress, invoice, subtotal, discount, finalCost } = req.body;
    const orderId = generateDateTimeOrderId();
    const createdAt = Date.now();
    const invoiceData = invoice && invoice.trim() !== "" ? invoice : "<p>Invoice details not available.</p>";
    const newDraft = {
      orderId,
      emailAddress: emailAddress || "",
      invoice: invoiceData,
      subtotal: subtotal || "",
      discount: discount || "",
      finalCost: finalCost || "",
      createdAt
    };
    draftOrders.push(newDraft);
    console.log("✅ Draft order received:", newDraft);
    saveOrdersData();
    res.json({
      success: true,
      message: "Draft order received",
      orderId
    });
  } catch (err) {
    console.error("Error in /submit-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

/** (B) /update-order -> resume.html (파일 업로드, draft 갱신) */
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
  if (invoice) existingOrder.invoice = invoice;
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

/** (C) /final-submit -> submit.html (최종 제출) */
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
    
    const newFinalOrderId = generateDateTimeOrderId();
    const finalInvoice = (existingDraft && existingDraft.invoice) ? existingDraft.invoice : (invoice || "<p>Invoice details not available.</p>");
    
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
    
    // (2) 클라이언트(인보이스) 이메일 발송
    if (emailAddress) {
      const templatePath = path.join(__dirname, "email.html");
      console.log("Looking for email template at:", templatePath);
      let clientEmailHtml = "";
      if (fs.existsSync(templatePath)) {
        clientEmailHtml = fs.readFileSync(templatePath, "utf-8");
      } else {
        clientEmailHtml = `<html><body><p>Invoice details not available.</p></body></html>`;
      }
      clientEmailHtml = juice(clientEmailHtml);
      clientEmailHtml = clientEmailHtml.replace(/{{\s*invoice\s*}}/g, finalInvoice);
      const clientMailOptions = {
        from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
        to: emailAddress,
        subject: "[Smart Talent Matcher] Invoice for Your Submission",
        html: clientEmailHtml
      };
      const clientInfo = await transporter.sendMail(clientMailOptions);
      console.log("✅ Invoice email sent to client:", clientInfo.response);
    }
    
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

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  finalOrders.forEach(order => {
    scheduleReminder(order);
    scheduleAutoCancel(order);
  });
});
