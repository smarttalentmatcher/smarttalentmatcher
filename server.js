//
// server.js (ESM 버전) - 12시간 리마인드 + 24시간 자동취소 + Mailgun 연동
//

// ──────────────────────────────────────────────
// [환경 설정 및 모듈 임포트]
// ──────────────────────────────────────────────
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import nodemailer from "nodemailer";
import mailgunTransport from "nodemailer-mailgun-transport"; // Mailgun Transport 추가
import multer from "multer";
import path from "path";
import fs from "fs";
import juice from "juice";
import cors from "cors";
import mongoose from "mongoose";
import fetch from "node-fetch";

// Cloudinary 관련 모듈 (v2 방식 사용)
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

// form-data (ESM 방식으로 불러오기)
import FormData from "form-data";

// HTTPS 모듈 (Smartlead API 호출 시 TLS 옵션 설정용)
import https from "https";

// ESM 환경에서 __dirname 생성 (CommonJS의 __dirname 대체)
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────────────
// [Cloudinary 설정 및 Storage 구성]
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const headshotStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "SmartTalentMatcher/headshots", // Cloudinary 내 저장 폴더
    allowed_formats: ["jpg", "jpeg", "png"]
  }
});
const uploadHeadshot = multer({ storage: headshotStorage });

// ──────────────────────────────────────────────
// [MongoDB 연결 및 Mongoose 모델 정의]
// ──────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas");
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
  });

// Mongoose Order 모델 정의
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
  headshot: { type: String, default: "" }, // Cloudinary URL 저장
  status: { type: String, default: "draft" } // "draft", "final", "canceled"
});
const Order = mongoose.model("Order", orderSchema);

// ──────────────────────────────────────────────
// [Express 앱 및 미들웨어 설정]
// ──────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ──────────────────────────────────────────────
// [유틸리티 함수: 날짜 기반 Order ID 생성]
// ──────────────────────────────────────────────
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

// ──────────────────────────────────────────────
// [Nodemailer 설정 (Mailgun Transport)]
// ──────────────────────────────────────────────
const mailgunAuth = {
  auth: {
    api_key: process.env.MAILGUN_API_KEY,      // .env에 저장
    domain: process.env.MAILGUN_DOMAIN        // .env에 저장
  }
};

const transporter = nodemailer.createTransport(mailgunTransport(mailgunAuth));

// ──────────────────────────────────────────────
// [타이머 관련 상수 & 변수]
// ──────────────────────────────────────────────
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const reminderTimers = {};
const autoCancelTimers = {};

// ──────────────────────────────────────────────
// [12시간 후 리마인드 이메일 스케줄링 / 전송]
// ──────────────────────────────────────────────
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
        from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
        to: savedOrder.emailAddress,
        subject: "**Reminder** [Smart Talent Matcher] Invoice for Your Submission",
        html: reminderEmailHtml
      };
      transporter.sendMail(mailOptions)
        .then((info) => {
          console.log(`✅ Reminder email sent for #${order.orderId}:`, info);
          savedOrder.reminderSent = true;
          return savedOrder.save();
        })
        .catch((err) => console.error("❌ Error sending reminder:", err));
    })
    .catch((err) => console.error("DB Error:", err));
}

// ──────────────────────────────────────────────
// [24시간 후 자동취소 스케줄링 / 실행]
// ──────────────────────────────────────────────
function scheduleAutoCancel(order) {
  // 24시간 후 - 지금까지 남은 시간
  const timeLeft = order.createdAt.getTime() + TWENTY_FOUR_HOURS - Date.now();
  // 아직 24시간이 안 지나고, paid가 아니면 스케줄
  if (timeLeft > 0 && !order.paid) {
    // 기존 타이머 있으면 제거
    if (autoCancelTimers[order.orderId]) {
      clearTimeout(autoCancelTimers[order.orderId]);
      delete autoCancelTimers[order.orderId];
    }
    autoCancelTimers[order.orderId] = setTimeout(() => autoCancelOrder(order), timeLeft);
    console.log(
      `⏰ Scheduled auto-cancel for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`
    );
  }
}

function autoCancelOrder(order) {
  // 이미 결제됐으면 취소 X
  if (order.paid) return;

  // 자동취소 메일
  const cancelHtml = `
    <div style="font-family: Arial, sans-serif;">
      <p>Hello,</p>
      <p>Your invoice (Order #${order.orderId}) has been <strong>canceled</strong> (24h passed).</p>
      <br>
      <p>Regards,<br>Smart Talent Matcher</p>
    </div>
  `;
  const mailOptions = {
    from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
    to: order.emailAddress,
    subject: "[Smart Talent Matcher] Invoice Auto-Canceled (24h Passed)",
    html: cancelHtml
  };

  transporter.sendMail(mailOptions)
    .then(async (info) => {
      console.log(`🚨 Auto-cancel email sent for #${order.orderId}:`, info);

      // DB에서 해당 주문 삭제
      await Order.deleteOne({ orderId: order.orderId, status: order.status });
      console.log(`Order #${order.orderId} removed from DB.`);
    })
    .catch((err) => console.error("❌ Error sending auto-cancel:", err));
}

// ──────────────────────────────────────────────
// [서버 시작 시, 미결제 final 주문에 대해 리마인더/자동취소 스케줄 복원]
// ──────────────────────────────────────────────
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
// [라우트 설정]
// ──────────────────────────────────────────────

// 메인 "/" → resume.html 제공
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

// 헤드샷 테스트 이메일 엔드포인트 (Cloudinary 업로드 사용)
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
      from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
      to: emailAddress,
      subject: emailSubject,
      html: emailHtml
    };
    console.log("Sending test email to:", emailAddress);
    const info = await transporter.sendMail(mailOptions);
    console.log("Test Email sent:", info);
    res.json({ success: true, message: "Test email sent successfully!" });
  } catch (error) {
    console.error("Error sending test email:", error);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

// (A) /submit-order : 드래프트 주문 생성 (choose.html)
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

// (B) /update-order : 드래프트 주문 업데이트 (파일 업로드 포함, resume.html)
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

// (C) /final-submit : 최종 주문 제출 (submit.html) – 드래프트 주문을 final로 전환
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log("Final submit received:", req.body);

    // 기존 final 주문(미결제) 취소 및 삭제 처리 (중복 방지)
    const oldFinals = await Order.find({ emailAddress, status: "final", paid: false });
    if (oldFinals.length > 0) {
      console.log(`Found ${oldFinals.length} old final orders for ${emailAddress}. Deleting them...`);
      for (const oldOrder of oldFinals) {
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
          from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
          to: emailAddress,
          subject: "[Smart Talent Matcher] Previous Invoice Canceled",
          html: cancelHtml
        });
        console.log(`Cancellation email sent for old order #${oldOrder.orderId}.`);

        // Cloudinary 이미지 삭제
        if (oldOrder.headshot) {
          const parts = oldOrder.headshot.split('/');
          const uploadIndex = parts.findIndex(part => part === "upload");
          if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
            const fileNameWithExtension = parts.slice(uploadIndex + 2).join('/');
            const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
            console.log("Deleting Cloudinary resource with public_id:", publicId);
            await cloudinary.uploader.destroy(publicId);
          }
        }

        await Order.deleteOne({ _id: oldOrder._id });
        console.log(`Deleted old final order #${oldOrder.orderId} from MongoDB.`);
      }
    }

    // 드래프트 주문을 최종 주문으로 전환
    const draftOrder = await Order.findOne({ orderId, status: "draft" });
    if (!draftOrder) {
      return res.status(404).json({ success: false, message: "Draft order not found" });
    }

    if (invoice && invoice.trim() !== "") {
      draftOrder.invoice = invoice;
    }
    // 새 final Order ID 발급
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

    // 관리자 이메일 발송 (to admin: info@smarttalentmatcher.com)
    const formattedIntro = introduction ? introduction.replace(/\r?\n/g, "<br>") : "";
    let adminEmailHtml = `<div style="font-family: Arial, sans-serif;">`;
    if (draftOrder.headshot) {
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
      from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
      to: "info@smarttalentmatcher.com",
      subject: emailSubject || "[No Subject Provided]",
      html: adminEmailHtml
    };
    const adminInfo = await transporter.sendMail(adminMailOptions);
    console.log("✅ Admin email sent:", adminInfo);

    // 클라이언트 Invoice 이메일
    const templatePath = path.join(__dirname, "email.html");
    let emailHtml = fs.existsSync(templatePath)
      ? fs.readFileSync(templatePath, "utf-8")
      : "<html><body><p>Invoice details not available.</p></body></html>";
    emailHtml = emailHtml.replace(/{{\s*invoice\s*}}/g, draftOrder.invoice);
    await transporter.sendMail({
      from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
      to: draftOrder.emailAddress,
      subject: "[Smart Talent Matcher] Invoice for Your Submission",
      html: emailHtml
    });
    console.log("✅ Client Invoice email sent.");

    // 12시간 리마인더/24시간 자동취소 스케줄링
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);

    // ──────────────────────────────────────────────
    // [Smartlead API를 통한 대량 이메일 캠페인 시작]
    // ──────────────────────────────────────────────
    const smartleadAgent = new https.Agent({
      // 임시로 SSL 인증서 무시
      rejectUnauthorized: false
    });

    const csvFolderPath = path.join(__dirname, "csv");
    let smartleadSuccess = true;
    try {
      const csvFiles = fs.readdirSync(csvFolderPath).filter(file => file.endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.warn("⚠️ No CSV files found in folder:", csvFolderPath);
      } else {
        for (const csvFile of csvFiles) {
          const csvFilePath = path.join(csvFolderPath, csvFile);
          const form = new FormData();
          form.append("apiKey", process.env.SMARTLEAD_API_KEY);
          form.append("orderId", draftOrder.orderId);
          form.append("recipientCsv", fs.createReadStream(csvFilePath));
          form.append("emailSubject", "[Smart Talent Matcher] Your Service Has Started!");
          form.append("emailHtml", emailHtml);
          form.append("fromEmail", "info@smarttalentmatcher.com");

          const smartleadResponse = await fetch("https://api.smartlead.io/start-campaign", {
            method: "POST",
            headers: form.getHeaders(),
            body: form,
            agent: smartleadAgent
          });

          const smartleadResult = await smartleadResponse.json();
          if (smartleadResult.success) {
            console.log(`✅ Smartlead email campaign started successfully for Order #${draftOrder.orderId} using CSV file ${csvFile}`);
          } else {
            console.error(`❌ Failed to start Smartlead email campaign for CSV file ${csvFile}: ${smartleadResult.message}`);
            smartleadSuccess = false;
          }
        }
      }
    } catch (err) {
      console.error("❌ Error starting Smartlead email campaign:", err);
      smartleadSuccess = false;
    }

    res.json({
      success: true,
      message: "Final submission complete! Emails sent, reminders scheduled, and campaign started."
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

// 관리자 주문 조회 API
app.get("/admin/orders", async (req, res) => {
  try {
    const now = Date.now();
    const orders = await Order.find({ status: "final" });
    const processedOrders = orders.map((order) => {
      const timeSinceCreation = now - order.createdAt.getTime();
      // 24시간 넘은 경우 'expired' 표시(자동취소는 이미 scheduleAutoCancel로 처리됨)
      const expired = !order.paid && timeSinceCreation >= 24 * 60 * 60 * 1000 ? "24hrs" : "";
      return { ...order.toObject(), expired };
    });

    // 48시간 넘은 미결제 주문은 DB에서 삭제
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

// 관리자 주문 삭제 API
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
      from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
      to: emailAddress,
      subject: "[Smart Talent Matcher] Invoice Canceled (Admin)",
      html: cancelHtml
    });

    // Cloudinary에 업로드된 이미지 제거
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

    await Order.deleteOne({ orderId, status: "final" });
    console.log("✅ Order deleted:", order.orderId);

    res.json({ success: true, message: `Order #${order.orderId} deleted. Cancel email sent.` });
  } catch (err) {
    console.error("❌ Error deleting order:", err);
    res.status(500).json({ success: false, message: "Failed to delete order" });
  }
});

// [결제 상태 업데이트 & Smartlead 캠페인 시작]
app.post("/admin/update-payment", async (req, res) => {
  try {
    const { orderId, paid } = req.body;
    const order = await Order.findOne({ orderId, status: "final" });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    order.paid = Boolean(paid);
    await order.save();
    console.log(`✅ Order #${orderId} payment status updated to ${order.paid}`);

    if (order.paid) {
      let emailHtml = `
        <div style="font-size: 1.2rem; font-weight: bold; margin-top: 20px;">
          🎉 Your service has started! 🎉
        </div>
        <br><br>
        <p><strong>Dear Customer,</strong></p>
        <br><br>
        <p>We are pleased to inform you that your payment has been successfully processed, and your service has now begun.</p>
        <br>
        <p>Once all emails corresponding to your selected region have been sent, you will receive a confirmation email.</p>
        <br>
        <p>Thank you for trusting our service. We are committed to helping you find the right people.</p>
        <br><br>
        <p>Best Regards,</p>
        <p><strong>Smart Talent Matcher Team</strong></p>
      `;

      // 결제 완료 이메일 발송
      await transporter.sendMail({
        from: `"Smart Talent Matcher" <info@smarttalentmatcher.com>`,
        to: order.emailAddress,
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        html: emailHtml
      });
      console.log(`📩 Service start email sent to ${order.emailAddress}`);

      // Smartlead API 호출
      const smartleadAgent = new https.Agent({
        rejectUnauthorized: false
      });
      const csvFolderPath = path.join(__dirname, "csv");
      let smartleadSuccess = true;
      try {
        const csvFiles = fs.readdirSync(csvFolderPath).filter(file => file.endsWith(".csv"));
        if (csvFiles.length === 0) {
          console.warn("⚠️ No CSV files found in folder:", csvFolderPath);
        } else {
          for (const csvFile of csvFiles) {
            const csvFilePath = path.join(csvFolderPath, csvFile);
            const form = new FormData();
            form.append("apiKey", process.env.SMARTLEAD_API_KEY);
            form.append("orderId", order.orderId);
            form.append("recipientCsv", fs.createReadStream(csvFilePath));
            form.append("emailSubject", "[Smart Talent Matcher] Your Service Has Started!");
            form.append("emailHtml", emailHtml);
            form.append("fromEmail", "info@smarttalentmatcher.com");

            const smartleadResponse = await fetch("https://api.smartlead.io/start-campaign", {
              method: "POST",
              headers: form.getHeaders(),
              body: form,
              agent: smartleadAgent
            });
            const smartleadResult = await smartleadResponse.json();
            if (smartleadResult.success) {
              console.log(`✅ Smartlead email campaign started successfully for Order #${order.orderId} using CSV file ${csvFile}`);
            } else {
              console.error(`❌ Failed to start Smartlead email campaign for CSV file ${csvFile}: ${smartleadResult.message}`);
              smartleadSuccess = false;
            }
          }
        }
      } catch (err) {
        console.error("❌ Error starting Smartlead email campaign:", err);
        smartleadSuccess = false;
      }
    }

    res.json({
      success: true,
      message: "Payment status updated, service start email sent, and email campaign started if paid."
    });
  } catch (err) {
    console.error("❌ Error updating payment, sending email, or starting campaign:", err);
    res.status(500).json({ success: false, message: "Database error, email sending failed, or email campaign failed." });
  }
});

// 관리자 결제 토글 라우트 (테스트용)
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

// ──────────────────────────────────────────────
// [비최종 주문 정리 (서버 시작 시 실행)]
// ──────────────────────────────────────────────
const cleanUpNonFinalOrders = async () => {
  try {
    // draft 상태 등 final 이 아닌 것 모두 정리
    const orders = await Order.find({ status: { $ne: "final" } });
    for (const order of orders) {
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
      await Order.deleteOne({ _id: order._id });
    }
    console.log(`Cleaned up ${orders.length} non-final orders on startup.`);
  } catch (err) {
    console.error("Error cleaning up non-final orders on startup:", err);
  }
};

// ──────────────────────────────────────────────
// [서버 시작 및 초기 작업 실행]
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running at ${process.env.SERVER_URL || "http://localhost:" + PORT}`);
  restoreTimers();
  cleanUpNonFinalOrders();
});