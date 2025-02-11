//
// server.js
//

// 환경변수 로드를 위해 dotenv 초기화 (.env 파일에서 환경변수 불러옴)
require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const juice = require("juice");
const cors = require("cors");
const mongoose = require("mongoose"); // MongoDB 사용

// ★ Cloudinary 관련 패키지 불러오기
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// ★ Cloudinary 설정
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ★ Cloudinary Storage 설정 (헤드샷 전용)
const headshotStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "SmartTalentMatcher/headshots", // Cloudinary 내 저장 폴더
    allowed_formats: ["jpg", "jpeg", "png"]
  }
});
const uploadHeadshot = multer({ storage: headshotStorage });

//
// MongoDB 연결
//
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
  });

/* ─────────────────────────────────────
   Mongoose Order 모델 정의  
   주문 데이터를 DB에 저장하기 위한 스키마를 정의합니다.
──────────────────────────────────────── */
const orderSchema = new mongoose.Schema({
  orderId: String,
  emailAddress: { type: String, default: "" },
  invoice: { type: String, default: "<p>Invoice details not available.</p>" },
  subtotal: { type: Number, default: 0 },
  baseDiscount: { type: Number, default: 0 },
  promoDiscount: { type: Number, default: 0 },
  finalCost: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  paid: { type: Boolean, default: false },
  reminderSent: { type: Boolean, default: false },
  emailSubject: { type: String, default: "" },
  actingReel: { type: String, default: "" },
  resumeLink: { type: String, default: "" },
  introduction: { type: String, default: "" },
  venmoId: { type: String, default: "" },
  // headshot는 Cloudinary URL을 저장합니다.
  headshot: { type: String, default: "" },
  status: { type: String, default: "draft" } // "draft", "final", "canceled"
});
const Order = mongoose.model("Order", orderSchema);

//
// Express 앱 생성
//
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

// Multer 설정  
// → 헤드샷 업로드는 Cloudinary 미들웨어(uploadHeadshot) 사용  
// (resume 등 다른 파일은 필요 시 별도 처리 가능)
const uploadResume = multer({ dest: "uploads/resume/" });

// 정적 파일 제공 (로컬 파일 접근용 - resume 파일 등)
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
    user: process.env.NODemailer_USER,
    pass: process.env.NODemailer_PASS
  }
});

// ================================
// 타이머 관련 상수 및 변수 (메모리 기반)
// ================================
const TWELVE_HOURS = 12 * 60 * 60 * 1000; // 12시간 (12 * 60 * 60 * 1000 밀리초)
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; // 24시간 (24 * 60 * 60 * 1000 밀리초)

const reminderTimers = {};
const autoCancelTimers = {};

// ================================
// 리마인더 이메일 스케줄링 함수
// ================================
function scheduleReminder(order) {
  const timeLeft = order.createdAt.getTime() + TWELVE_HOURS - Date.now();
  if (timeLeft > 0 && !order.paid && !order.reminderSent) {
    if (reminderTimers[order.orderId]) {
      clearTimeout(reminderTimers[order.orderId]);
      delete reminderTimers[order.orderId];
    }
    reminderTimers[order.orderId] = setTimeout(() => sendReminder(order), timeLeft);
    console.log(`⏰ Scheduled reminder for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
  }
}

// ================================
// 자동 취소 이메일 스케줄링 함수
// ================================
function scheduleAutoCancel(order) {
  const timeLeft = order.createdAt.getTime() + TWENTY_FOUR_HOURS - Date.now();
  if (timeLeft > 0 && !order.paid) {
    if (autoCancelTimers[order.orderId]) {
      clearTimeout(autoCancelTimers[order.orderId]);
      delete autoCancelTimers[order.orderId];
    }
    autoCancelTimers[order.orderId] = setTimeout(() => autoCancelOrder(order), timeLeft);
    console.log(`⏰ Scheduled auto-cancel for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
  }
}

// ================================
// 리마인더 이메일 전송 함수
// ================================
function sendReminder(order) {
  if (order.paid || order.reminderSent) return;

  Order.findOne({ orderId: order.orderId, status: order.status })
    .then((savedOrder) => {
      if (!savedOrder) {
        console.error(`❌ Order #${order.orderId} not found in DB.`);
        return;
      }

      const templatePath = path.join(__dirname, "email.html");
      let reminderEmailHtml = fs.existsSync(templatePath)
        ? fs.readFileSync(templatePath, "utf-8")
        : "<html><body><p>Invoice details not available.</p></body></html>";

      reminderEmailHtml = reminderEmailHtml.replace(/{{\s*invoice\s*}}/g, savedOrder.invoice);

      const mailOptions = {
        from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
        to: savedOrder.emailAddress,
        subject: "**Reminder** [Smart Talent Matcher] Invoice for Your Submission",
        html: reminderEmailHtml
      };

      transporter
        .sendMail(mailOptions)
        .then((info) => {
          console.log(`✅ Reminder email sent for #${order.orderId}:`, info.response);
          savedOrder.reminderSent = true;
          return savedOrder.save();
        })
        .catch((err) => console.error("❌ Error sending reminder:", err));
    })
    .catch((err) => console.error("DB Error:", err));
}

// ================================
// 자동 취소 이메일 전송 함수
// ================================
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

  transporter
    .sendMail(mailOptions)
    .then((info) => {
      console.log(`🚨 Auto-cancel email sent for #${order.orderId}:`, info.response);
      Order.deleteOne({ orderId: order.orderId, status: order.status })
        .then(() => console.log(`Order #${order.orderId} removed from DB.`))
        .catch((err) => console.error("❌ Error deleting order:", err));
    })
    .catch((err) => console.error("❌ Error sending auto-cancel:", err));
}

// ================================
// 서버 시작 시 기존 주문을 다시 스케줄링 (서버 재시작 시 타이머 복원)
// ================================
async function restoreTimers() {
  try {
    const pendingOrders = await Order.find({ status: "final", paid: false });

    pendingOrders.forEach((order) => {
      if (!order.reminderSent) scheduleReminder(order);
      scheduleAutoCancel(order);
    });

    console.log(`✅ Restored ${pendingOrders.length} orders with pending reminders and cancellations.`);
  } catch (err) {
    console.error("❌ Error restoring timers:", err);
  }
}

// ──────────────────────────────────────────────
// 라우트
// ──────────────────────────────────────────────

// 메인 "/" → resume.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

// ★ 헤드샷 테스트 이메일 엔드포인트 (Cloudinary 업로드 사용)
app.post("/send-test-email", uploadHeadshot.single("headshot"), async (req, res) => {
  try {
    const { emailAddress, emailSubject, actingReel, resumeLink, introduction } = req.body;
    const formattedIntro = introduction ? introduction.replace(/\r?\n/g, "<br>") : "";
    let emailHtml = `<div style="font-family: Arial, sans-serif;">`;
    if (req.file) {
      emailHtml += `
        <div>
          <img src="${req.file.path}" style="max-width:600px; width:100%; height:auto;" alt="Headshot" />
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
      html: emailHtml
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

/** (A) /submit-order → choose.html (드래프트 주문 생성)
 *  주문 데이터를 MongoDB에 저장하도록 수정함.
 */
app.post("/submit-order", async (req, res) => {
  try {
    const { emailAddress, invoice, subtotal, baseDiscount, promoDiscount, finalCost } = req.body;
    const orderId = generateDateTimeOrderId();
    const createdAt = Date.now();
    const cleanSubtotal = isNaN(parseFloat(subtotal)) ? 0 : parseFloat(subtotal);
    const cleanBaseDiscount = isNaN(parseFloat(baseDiscount)) ? 0 : parseFloat(baseDiscount);
    const cleanPromoDiscount = isNaN(parseFloat(promoDiscount)) ? 0 : parseFloat(promoDiscount);
    const cleanFinalCost = isNaN(parseFloat(finalCost)) ? 0 : parseFloat(finalCost);
    const invoiceData = invoice && invoice.trim() !== "" ? invoice : "<p>Invoice details not available.</p>";

    const newOrder = new Order({
      orderId,
      emailAddress: emailAddress || "",
      invoice: invoiceData,
      subtotal: cleanSubtotal,
      baseDiscount: cleanBaseDiscount,
      promoDiscount: cleanPromoDiscount,
      finalCost: cleanFinalCost,
      createdAt,
      status: "draft"
    });

    await newOrder.save();
    console.log("✅ Draft order saved to MongoDB:", newOrder);
    res.json({
      success: true,
      message: "Draft order saved to MongoDB",
      orderId: newOrder.orderId
    });
  } catch (err) {
    console.error("Error in /submit-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

/** (B) /update-order → resume.html (파일 업로드, draft 갱신)
 *  → MongoDB에서 해당 draft 주문을 찾아 업데이트함.
 *  ★ 수정: 헤드샷 업로드 시 Cloudinary를 사용하도록 uploadHeadshot 미들웨어 적용
 */
app.post("/update-order", uploadHeadshot.single("headshot"), async (req, res) => {
  try {
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice } = req.body;
    const order = await Order.findOne({ orderId, status: "draft" });
    if (!order) {
      console.error("Draft order not found for orderId:", orderId);
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (emailAddress !== undefined) order.emailAddress = emailAddress;
    if (emailSubject !== undefined) order.emailSubject = emailSubject;
    if (actingReel !== undefined) order.actingReel = actingReel;
    if (resumeLink !== undefined) order.resumeLink = resumeLink;
    if (introduction !== undefined) order.introduction = introduction;
    if (invoice && invoice.trim() !== "") order.invoice = invoice;
    // 헤드샷 파일이 업로드되면, Cloudinary URL (req.file.path) 사용
    if (req.file) {
      order.headshot = req.file.path;
    }

    await order.save();
    console.log("✅ Draft order updated in MongoDB:", order);
    res.json({
      success: true,
      message: "Draft order updated",
      updatedOrder: order
    });
  } catch (err) {
    console.error("Error in /update-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

/** (C) /final-submit → submit.html (최종 제출)
 *  draft 주문을 final 주문으로 전환하고, 관련 이메일 및 타이머를 설정함.
 */
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log("Final submit received:", req.body);

    // 기존 최종 주문 취소 (해당 이메일의 final 주문들) 및 삭제 (MongoDB + Cloudinary)
    const oldFinals = await Order.find({ emailAddress, status: "final" });
    if (oldFinals.length > 0) {
      console.log(`Found ${oldFinals.length} old final orders for ${emailAddress}. Deleting them...`);
      for (const oldOrder of oldFinals) {
        // 취소 이메일 전송
        const cancelHtml = `
          <div style="font-family: Arial, sans-serif;">
            <p>Hello,</p>
            <p>Your previous invoice (Order #${oldOrder.orderId}) has been <strong>canceled</strong> because a new order was submitted.</p>
            <p>Only the new invoice will remain valid. If you have any questions, please contact us.</p>
            <br>
            <p>Regards,<br>Smart Talent Matcher</p>
          </div>
        `;
        await transporter.sendMail({
          from: `"Smart Talent Matcher" <${process.env.NODemailer_USER || "letsspeak01@naver.com"}>`,
          to: emailAddress,
          subject: "[Smart Talent Matcher] Previous Invoice Canceled",
          html: cancelHtml
        });
        console.log(`Cancellation email sent for old order #${oldOrder.orderId}.`);

        // Cloudinary에서 헤드샷 삭제 (이미지 존재하는 경우)
        if (oldOrder.headshot) {
          const parts = oldOrder.headshot.split('/');
          const uploadIndex = parts.findIndex(part => part === "upload");
          if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
            const fileNameWithExtension = parts.slice(uploadIndex + 2).join('/'); 
            const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, ""); // 확장자 제거
            console.log("Deleting Cloudinary resource with public_id:", publicId);
            await cloudinary.uploader.destroy(publicId);
          }
        }

        // MongoDB에서 기존 주문 삭제
        await Order.deleteOne({ _id: oldOrder._id });
        console.log(`Deleted old final order #${oldOrder.orderId} from MongoDB.`);
      }
    }
    // draft 주문을 찾기
    const draftOrder = await Order.findOne({ orderId, status: "draft" });
    if (!draftOrder) {
      return res.status(404).json({ success: false, message: "Draft order not found" });
    }
    if (invoice && invoice.trim() !== "") {
      draftOrder.invoice = invoice;
    }
    // 새로운 final 주문 ID 생성 및 주문 업데이트
    const newFinalOrderId = generateDateTimeOrderId();
    draftOrder.orderId = newFinalOrderId;
    draftOrder.emailSubject = emailSubject || "";
    draftOrder.actingReel = actingReel || "";
    draftOrder.resumeLink = resumeLink || "";
    draftOrder.introduction = introduction || "";
    draftOrder.venmoId = venmoId || "";
    draftOrder.status = "final";

    await draftOrder.save();
    console.log("✅ Final submission order updated in MongoDB:", draftOrder);

    // (1) 관리자 이메일 발송
    const formattedIntro = introduction ? introduction.replace(/\r?\n/g, "<br>") : "";
    let adminEmailHtml = `<div style="font-family: Arial, sans-serif;">`;
    if (draftOrder.headshot) {
      // 관리자 이메일에서 헤드샷 URL을 사용
      adminEmailHtml += `
        <div>
          <img src="${draftOrder.headshot}" style="max-width:600px; width:100%; height:auto;" alt="Headshot" />
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
      html: adminEmailHtml
    };
    const adminInfo = await transporter.sendMail(adminMailOptions);
    console.log("✅ Admin email sent:", adminInfo.response);

    // (4) 클라이언트 Invoice 이메일 전송
    const templatePath = path.join(__dirname, "email.html");
    let emailHtml = fs.existsSync(templatePath)
      ? fs.readFileSync(templatePath, "utf-8")
      : "<html><body><p>Invoice details not available.</p></body></html>";
    emailHtml = emailHtml.replace(/{{\s*invoice\s*}}/g, draftOrder.invoice);
    await transporter.sendMail({
      from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
      to: draftOrder.emailAddress,
      subject: "[Smart Talent Matcher] Invoice for Your Submission",
      html: emailHtml
    });
    console.log("✅ Client Invoice email sent.");

    // (3) 타이머 등록 (서버 재시작 전까지 메모리상에 유지됨)
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);

    res.json({
      success: true,
      message: "Final submission complete! Emails sent and timers set."
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

/** 
 * 📌 관리자 주문 조회 API
 * - `status: "final"`인 주문을 조회하여 반환
 * - 24시간이 지나면 `expired: "24hrs"`로 설정 (노란색 하이라이트)
 * - 48시간이 지나면 자동 삭제
 */
app.get("/admin/orders", async (req, res) => {
  try {
    const now = Date.now();
    const orders = await Order.find({ status: "final" });

    // 주문 상태 처리
    const processedOrders = orders.map((order) => {
      const timeSinceCreation = now - order.createdAt.getTime();

      // 24시간 초과 시 `expired: "24hrs"` (미결제 상태에서만 적용)
      const expired = !order.paid && timeSinceCreation >= 24 * 60 * 60 * 1000 ? "24hrs" : "";

      return { ...order.toObject(), expired };
    });

    // ✅ 48시간 초과된 미결제 주문 자동 삭제
    const deletedOrders = await Order.deleteMany({
      paid: false, 
      createdAt: { $lt: new Date(now - 48 * 60 * 60 * 1000) }
    });

    if (deletedOrders.deletedCount > 0) {
      console.log(`🗑️ Deleted ${deletedOrders.deletedCount} expired orders (48h old).`);
    }

    res.json(processedOrders);
  } catch (err) {
    console.error("❌ Error fetching orders:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

/** 관리자 주문 삭제 */
app.post("/admin/delete-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ orderId, status: "final" });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const emailAddress = order.emailAddress;
    const cancelHtml = `
      <div style="font-family: Arial, sans-serif;">
        <p>Hello,</p>
        <p>Your invoice (Order #${order.orderId}) has been <strong>canceled</strong> by the admin.</p>
        <br>
        <p>Regards,<br>Smart Talent Matcher</p>
      </div>
    `;
    await transporter.sendMail({
      from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
      to: emailAddress,
      subject: "[Smart Talent Matcher] Invoice Canceled (Admin)",
      html: cancelHtml
    });

    // Cloudinary에서 헤드샷 삭제 (order.headshot에 URL이 저장되어 있을 경우)
    if (order.headshot) {
      const parts = order.headshot.split('/');
      const uploadIndex = parts.findIndex(part => part === "upload");
      if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
        const fileNameWithExtension = parts.slice(uploadIndex + 2).join('/'); 
        const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, ""); // 확장자 제거
        console.log("Deleting Cloudinary resource with public_id:", publicId);
        await cloudinary.uploader.destroy(publicId);
      }
    }

    // MongoDB에서 주문 삭제
    await Order.deleteOne({ orderId, status: "final" });
    console.log("✅ Order deleted:", order.orderId);
    res.json({ success: true, message: `Order #${order.orderId} deleted. Cancel email sent.` });
  } catch (err) {
    console.error("❌ Error deleting order:", err);
    res.status(500).json({ success: false, message: "Failed to delete order" });
  }
});

/** 결제 상태 업데이트 및 서비스 시작 이메일 발송 + 대량 이메일 캠페인 시작 */
app.post("/admin/update-payment", async (req, res) => {
  try {
    const { orderId, paid } = req.body;
    const order = await Order.findOne({ orderId, status: "final" });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // ✅ 결제 상태 업데이트
    order.paid = Boolean(paid);
    await order.save();
    console.log(`✅ Order #${orderId} payment status updated to ${order.paid}`);

    // ✅ 결제가 완료되면, email.html 파일을 사용하지 않고, 아래 템플릿만 사용하여 서비스 시작 이메일 발송
    if (order.paid) {
      let emailHtml = `
        <div style="font-size: 1.2rem; font-weight: bold;  margin-top: 20px;">
          🎉 Your service has started! 🎉
        </div>
        <br>
        <p>Dear Customer,</p>
        <p>We are pleased to inform you that your payment has been successfully processed, and your service has now begun.</p>
        <p>Once all emails corresponding to your selected region have been sent, you will receive a confirmation email.</p>
        <p>Thank you for trusting our service. We are committed to helping you find the right people.</p>
        <br>
        <p>Best Regards,</p>
        <p><strong>Smart Talent Matcher Team</strong></p>
      `;

      await transporter.sendMail({
        from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
        to: order.emailAddress,
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        html: emailHtml
      });
      console.log(`📩 Service start email sent to ${order.emailAddress}`);

      // ✅ SendGrid 서버에 대량 이메일 캠페인 시작 요청
      const sendgridResponse = await fetch("http://localhost:4000/start-email-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, emailAddress: order.emailAddress })
      });
      const sendgridResult = await sendgridResponse.json();
      if (sendgridResult.success) {
        console.log(`✅ Email campaign started successfully for Order #${orderId}`);
      } else {
        console.error(`❌ Failed to start email campaign: ${sendgridResult.message}`);
      }
    }

    res.json({ success: true, message: "Payment status updated, service start email sent, and email campaign started if paid." });
  } catch (err) {
    console.error("❌ Error updating payment, sending email, or starting campaign:", err);
    res.status(500).json({ success: false, message: "Database error, email sending failed, or email campaign failed." });
  }
});

/** 
 * 새로 추가된 엔드포인트: /admin/toggle-payment
 * - GET 요청을 통해 쿼리 스트링으로 orderId와 paid (true/false)를 전달하면
 *   해당 주문의 결제 상태를 업데이트합니다.
 */
app.get("/admin/toggle-payment", async (req, res) => {
  try {
    const { orderId, paid } = req.query;
    const order = await Order.findOne({ orderId, status: "final" });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    order.paid = (paid === "true");
    await order.save();
    console.log(`✅ Order #${orderId} payment toggled to ${order.paid}`);
    res.json({ success: true, message: `Order #${orderId} updated to paid: ${order.paid}` });
  } catch (err) {
    console.error("❌ Error toggling payment:", err);
    res.status(500).json({ success: false, message: "Error updating payment status" });
  }
});

// ================================
// Cleanup Function: Remove non-final orders on startup
// ================================
const cleanUpNonFinalOrders = async () => {
  try {
    // Find all orders that are not in the "final" status
    const orders = await Order.find({ status: { $ne: "final" } });
    for (const order of orders) {
      // If the order has a headshot URL, delete the corresponding Cloudinary resource
      if (order.headshot) {
        const parts = order.headshot.split('/');
        const uploadIndex = parts.findIndex(part => part === "upload");
        if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
          const fileNameWithExtension = parts.slice(uploadIndex + 2).join('/');
          const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
          console.log("Deleting Cloudinary resource with public_id:", publicId);
          await cloudinary.uploader.destroy(publicId);
        }
      }
      // Delete the order from MongoDB
      await Order.deleteOne({ _id: order._id });
    }
    console.log(`Cleaned up ${orders.length} non-final orders on startup.`);
  } catch (err) {
    console.error("Error cleaning up non-final orders on startup:", err);
  }
};

// ================================
// Start the server and perform cleanup on startup
// ================================
app.listen(PORT, () => {
  console.log(`✅ Server running at ${process.env.SERVER_URL || "http://localhost:" + PORT}`);
  
  // 서버 재시작 시 타이머 복원 및 미완료 주문 cleanup
  restoreTimers();
  cleanUpNonFinalOrders();
});