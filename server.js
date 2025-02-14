// --------------------------------------------------------------------------------
// SERVER.JS (ESM 버전) - 전체 코드 (중복 함수 제거 & admin/orders 디버깅 포함)
// --------------------------------------------------------------------------------

// ───────── [필요한 import들 & dotenv 설정] ─────────
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import juice from "juice";
import cors from "cors";
import mongoose from "mongoose";
import fetch from "node-fetch";
import csvParser from "csv-parser";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import FormData from "form-data";
import https from "https";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────── [Cloudinary 설정] ─────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const headshotStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "SmartTalentMatcher/headshots",
    allowed_formats: ["jpg", "jpeg", "png"]
  }
});
const uploadHeadshot = multer({ storage: headshotStorage });

// ───────── [MongoDB 연결 & Mongoose 모델 정의] ─────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
console.log(">>>> [DEBUG] MONGO_URI =", MONGO_URI);

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas (or local)");
    console.log(">>>> [DEBUG] DB Name (via mongoose.connection.name) =", mongoose.connection.name);
  })
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// 주문 스키마 (Order)
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
  headshot: { type: String, default: "" },
  status: { type: String, default: "draft" }
});
const Order = mongoose.model("Order", orderSchema);

// 이메일 수신자 (BulkEmailRecipient) 스키마
const bulkEmailRecipientSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true }
});
const BulkEmailRecipient = mongoose.model("BulkEmailRecipient", bulkEmailRecipientSchema);

// ───────── [Express 앱 설정] ─────────
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


// ───────── [유틸 함수: 날짜 기반 Order ID 생성] ─────────
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

// ───────── [Elastic Email 이용 메일발송 함수] ─────────
async function sendEmailAPI({ subject, from, fromName, to, bodyHtml, isTransactional = true }) {
  const url = "https://api.elasticemail.com/v2/email/send";
  const params = new URLSearchParams();
  params.append("apikey", process.env.ELASTIC_EMAIL_API_KEY);
  params.append("subject", subject);
  params.append("from", from || process.env.ELASTIC_EMAIL_USER);
  params.append("fromName", fromName || "Smart Talent Matcher");
  params.append("to", to);
  params.append("bodyHtml", bodyHtml);
  params.append("isTransactional", isTransactional ? "true" : "false");
  try {
    const response = await fetch(url, { method: "POST", body: params });
    const data = await response.json();
    return data;
  } catch (err) {
    console.error("Error sending email via API:", err);
    throw err;
  }
}


// ───────── [CSV → BulkEmailRecipient 업로드 함수] ─────────
function uploadCSVToDB() {
  return new Promise((resolve, reject) => {
    // [FIX] 절대 경로 대신, server.js와 같은 폴더 (혹은 하위)로 가정
    // 예: server.js와 같은 디렉토리에 csv 폴더 존재
    const csvFolderPath = path.join(__dirname, "csv");

    // 폴더 존재 여부 체크
    if (!fs.existsSync(csvFolderPath)) {
      console.log(`No CSV folder found at: ${csvFolderPath}. Skipping CSV import.`);
      return resolve();
    }

    fs.readdir(csvFolderPath, (err, files) => {
      if (err) return reject(err);

      // .csv 확장자만 필터링
      const csvFiles = files.filter(file => file.endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }

      // 기존 BulkEmailRecipient 전체 삭제
      BulkEmailRecipient.deleteMany({})
        .then(() => {
          let filesProcessed = 0;
          csvFiles.forEach(file => {
            const filePath = path.join(csvFolderPath, file);

            fs.createReadStream(filePath)
              .pipe(csvParser())
              .on("data", (row) => {
                if (row.email) {
                  // email 필드가 있으면 upsert
                  BulkEmailRecipient.updateOne(
                    { email: row.email.trim() },
                    { email: row.email.trim() },
                    { upsert: true }
                  ).catch(err => console.error("Error upserting email:", err));
                }
              })
              .on("end", () => {
                filesProcessed++;
                if (filesProcessed === csvFiles.length) {
                  console.log("CSV files uploaded to DB.");
                  resolve();
                }
              })
              .on("error", (err) => reject(err));
          });
        })
        .catch(err => reject(err));
    });
  });
}

// ───────── [테스트 라우트, 필요한 라우트 추가 가능] ─────────
app.get("/", (req, res) => {
  res.send("<h1>Hello from server.js - CSV Reload test</h1>");
});
// ───────── [타이머 관련 상수 & 변수] ─────────
// (테스트용으로 1분, 3분, 5분으로 설정 - 실제 운영시 12시간, 24시간, 48시간으로 변경)
const TWELVE_HOURS = 12 * 60 * 60 * 1000;      
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; 
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000; 

const reminderTimers = {};
const autoCancelTimers = {};
const autoDeleteTimers = {};

// ───────── [12시간 후 리마인더 이메일 & 전송 함수] ─────────
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
      const mailData = {
        subject: "**Reminder** [Smart Talent Matcher] Invoice for Your Submission",
        from: process.env.ELASTIC_EMAIL_USER,
        fromName: "Smart Talent Matcher",
        to: savedOrder.emailAddress,
        bodyHtml: reminderEmailHtml,
        isTransactional: true
      };
      sendEmailAPI(mailData)
        .then((data) => {
          console.log(`✅ Reminder email sent for #${order.orderId}:`, data);
          savedOrder.reminderSent = true;
          return savedOrder.save();
        })
        .catch((err) => console.error("❌ Error sending reminder:", err));
    })
    .catch((err) => console.error("DB Error:", err));
}

// ───────── [24시간 후 자동 캔슬 & 프로모 코드 이메일 스케줄링] ─────────
function scheduleAutoCancel(order) {
  console.log(`>>> scheduleAutoCancel called for order #${order.orderId}`);
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
function autoCancelOrder(order) {
  if (order.paid) return;
  const cancelHtml = `
<!-- 테이블 100% 폭, 가운데 정렬 -->
<table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; background-color:#f9f9f9; color: #333; line-height:1.6;">
  <tr>
    <td align="center" style="padding: 30px;">
      <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff; border-radius:8px; padding:20px;">
        <tr>
          <td align="center" style="padding: 20px;">
            <h2 style="color:#d9534f; margin-top:0;">
              Your Invoice (Order #${order.orderId}) Has Been Canceled!
            </h2>
            <br><br>
            <p style="margin:0 0 15px 0;">
              Hello ${order.emailAddress ? order.emailAddress.split("@")[0] : ""},
            </p>
            <br>
            <p style="margin:0 0 15px 0;">
              We noticed you haven't completed your payment within 24 hours,<br>
              so your invoice for <strong>Order #${order.orderId}</strong> has been 
              <strong>automatically canceled</strong>.
            </p>
            <br>
            <p style="margin:0 0 15px 0;">
              However, we don’t want you to miss out on this opportunity.<br>
              Use the promo code below to get <strong>10% off</strong> on your next order:
            </p>
            <div style="
              font-size: 1.4rem; 
              font-weight: bold; 
              background:#28a745; 
              color:#ffffff;
              border-radius:8px;
              display:inline-block;
              padding:10px 20px; 
              margin:15px 0;
            ">
              WELCOME10
            </div>
            <p style="margin:15px 0 20px 0;">
              Simply apply this code when creating a new order.
            </p>
            <br><br>
            <a 
              href="smarttalentmatcher.com" 
              target="_blank" 
              style="
                display: inline-block;
                background: #00BCD4;
                color: #FFFFFF;
                padding: 20px 40px;
                font-size: 1.5rem;
                font-weight: bold;
                font-style: italic;
                border-radius: 30px;
                border: 4px solid #001f3f;
                transition: background 0.3s ease;
                box-shadow: 0 8px 12px rgba(0,0,0,0.4);
                text-decoration: none;
              "
              rel="noopener noreferrer"
            >
              Get Started
            </a>
            <br><br>
            <p style="margin:30px 0 0 0;">
              Best Regards,<br>
              Smart Talent Matcher
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
  const mailData = {
    subject: "[Smart Talent Matcher] Invoice Auto-Canceled (24h) - Enjoy 10% Off with WELCOME10",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: cancelHtml,
    isTransactional: true
  };
  sendEmailAPI(mailData)
    .then((data) => {
      console.log(`✅ Auto-cancel email sent for #${order.orderId}:`, data);
      // 필요에 따라 주문 상태를 "canceled" 등으로 업데이트할 수 있음.
    })
    .catch((err) => console.error("❌ Error sending auto-cancel email:", err));
}

// ───────── [48시간 후 주문 자동 삭제 함수 (DB & Cloudinary)] ─────────
function scheduleAutoDelete(order) {
  const timeLeft = order.createdAt.getTime() + FORTY_EIGHT_HOURS - Date.now();
  if (timeLeft > 0 && !order.paid) {
    if (autoDeleteTimers[order.orderId]) {
      clearTimeout(autoDeleteTimers[order.orderId]);
      delete autoDeleteTimers[order.orderId];
    }
    autoDeleteTimers[order.orderId] = setTimeout(() => autoDeleteOrder(order), timeLeft);
    console.log(`⏰ Scheduled auto-delete for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
  }
}
async function autoDeleteOrder(order) {
  if (order.paid) return;
  console.log(`>>> autoDeleteOrder called for order #${order.orderId}`);
  // Cloudinary 업로드(헤드샷) 삭제
  if (order.headshot) {
    const parts = order.headshot.split("/");
    const uploadIndex = parts.findIndex((part) => part === "upload");
    if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
      const fileNameWithExtension = parts.slice(uploadIndex + 2).join("/");
      const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
      console.log("Deleting Cloudinary resource with public_id:", publicId);
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (err) {
        console.error("Error deleting Cloudinary resource:", err);
      }
    }
  }
  // 주문을 DB에서 삭제
  try {
    await Order.deleteOne({ orderId: order.orderId });
    console.log(`✅ Order #${order.orderId} auto-deleted from DB after 48 hours.`);
  } catch (err) {
    console.error("Error auto-deleting order from DB:", err);
  }
}

// ───────── [서버 시작 시, 미결제 final 주문에 대해 타이머 복원] ─────────
async function restoreTimers() {
  try {
    const pendingOrders = await Order.find({ status: "final", paid: false });
    console.log(`>>> [DEBUG] restoreTimers: found ${pendingOrders.length} final/pending orders.`);
    pendingOrders.forEach((order) => {
      if (!order.reminderSent) scheduleReminder(order);
      scheduleAutoCancel(order);
      scheduleAutoDelete(order);
    });
    console.log(`✅ Restored ${pendingOrders.length} orders with pending reminders, cancellations, and auto-deletions.`);
  } catch (err) {
    console.error("❌ Error restoring timers:", err);
  }
}

// ───────── [추가: 미제출(불완전한) 주문 정리 함수] ─────────
async function cleanUpIncompleteOrders() {
  // 24시간 전 시각 (실제 운영에서는 24시간, 테스트에서는 TWENTY_FOUR_HOURS 대신 직접 계산)
  const cutoff = new Date(Date.now() - (24 * 60 * 60 * 1000));
  // status가 draft인 주문 중 createdAt이 cutoff 이전인 주문 조회
  const orders = await Order.find({ status: "draft", createdAt: { $lt: cutoff } });
  for (const order of orders) {
    if (order.headshot) {
      const parts = order.headshot.split("/");
      const uploadIndex = parts.findIndex(part => part === "upload");
      if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
        const fileNameWithExtension = parts.slice(uploadIndex + 2).join("/");
        const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
        try {
          await cloudinary.uploader.destroy(publicId);
          console.log("Deleted Cloudinary image for incomplete order:", publicId);
        } catch (err) {
          console.error("Error deleting Cloudinary resource:", err);
        }
      }
    }
    await Order.deleteOne({ _id: order._id });
    console.log("Deleted incomplete order from DB:", order.orderId);
  }
}

// ───────── [추가: DB와 Cloudinary 동기화 함수] ─────────
async function syncCloudinaryWithDB() {
  try {
    // DB에서 headshot URL이 있는 모든 주문 조회
    const orders = await Order.find({ headshot: { $ne: "" } });
    const dbHeadshots = orders
      .map(order => {
        const parts = order.headshot.split("/");
        const uploadIndex = parts.findIndex(part => part === "upload");
        if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
          const fileNameWithExtension = parts.slice(uploadIndex + 2).join("/");
          return fileNameWithExtension.replace(/\.[^/.]+$/, "");
        }
        return null;
      })
      .filter(id => id);
    // Cloudinary API로 해당 폴더 내 최대 500개 리소스 조회
    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: "SmartTalentMatcher/headshots",
      max_results: 500
    });
    for (const resource of result.resources) {
      if (!dbHeadshots.includes(resource.public_id)) {
        // DB에 없는 이미지이면 삭제
        await cloudinary.uploader.destroy(resource.public_id);
        console.log("Deleted orphan Cloudinary image:", resource.public_id);
      }
    }
  } catch (error) {
    console.error("Error syncing Cloudinary with DB:", error);
  }
}

// ───────── [cleanUpNonFinalOrders (필요시 추가 정리 작업)] ─────────
const cleanUpNonFinalOrders = async () => {
  // 필요한 경우 추가 정리 작업 구현
};

// ───────── [라우트 설정] ─────────

// (기본 페이지)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

// (테스트 이메일 전송 라우트)
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
    const mailData = {
      subject: emailSubject,
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: emailAddress,
      bodyHtml: emailHtml,
      isTransactional: true
    };
    const result = await sendEmailAPI(mailData);
    console.log("Test Email sent:", result);
    res.json({ success: true, message: "Test email sent successfully!" });
  } catch (error) {
    console.error("Error sending test email:", error);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

// ───────── [주문 생성 라우트 (Draft Order 생성)] ─────────
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
    res.json({ success: true, message: "Draft order saved to MongoDB", orderId: newOrder.orderId });
  } catch (err) {
    console.error("Error in /submit-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [주문 수정 라우트 (Draft Order 업데이트)] ─────────
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
    if (req.file) order.headshot = req.file.path;
    await order.save();
    console.log("✅ Draft order updated in MongoDB:", order);
    res.json({ success: true, message: "Draft order updated", updatedOrder: order });
  } catch (err) {
    console.error("Error in /update-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [최종 제출 라우트 (Draft → Final 주문 전환)] ─────────
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    console.log(">>> [final-submit] Step 0: Endpoint called");
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log(">>> [final-submit] Step 1: Request body received:", req.body);
    console.log(">>> [final-submit] Step 2: Checking for old final (unpaid) orders with same emailAddress");
    
    const oldFinals = await Order.find({ emailAddress, status: "final", paid: false });
    if (oldFinals.length > 0) {
      console.log(`Found ${oldFinals.length} old final orders for ${emailAddress}. Deleting them...`);
      for (const oldOrder of oldFinals) {
        console.log(`>>> Canceling old final order #${oldOrder.orderId}`);
        const cancelHtml = `
          <div style="font-family: Arial, sans-serif;">
            <p>Hello,</p>
            <p>Your previous invoice (Order #${oldOrder.orderId}) has been <strong>canceled</strong> because a new order was submitted.</p>
            <p>Only the new invoice will remain valid. If you have any questions, please contact us.</p>
            <br>
            <p>Regards,<br>Smart Talent Matcher</p>
          </div>
        `;
        console.log(">>> Sending cancellation email for old order:", oldOrder.orderId);
        await sendEmailAPI({
          subject: "[Smart Talent Matcher] Previous Invoice Canceled",
          from: process.env.ELASTIC_EMAIL_USER,
          fromName: "Smart Talent Matcher",
          to: emailAddress,
          bodyHtml: cancelHtml,
          isTransactional: true
        });
        console.log(`Cancellation email sent for old order #${oldOrder.orderId}.`);

        if (oldOrder.headshot) {
          const parts = oldOrder.headshot.split("/");
          const uploadIndex = parts.findIndex((part) => part === "upload");
          if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
            const fileNameWithExtension = parts.slice(uploadIndex + 2).join("/");
            const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
            console.log("Deleting Cloudinary resource with public_id:", publicId);
            await cloudinary.uploader.destroy(publicId);
          }
        }
        console.log(">>> Deleting old final order from DB:", oldOrder.orderId);
        await Order.deleteOne({ _id: oldOrder._id });
        console.log(`Deleted old final order #${oldOrder.orderId} from MongoDB.`);
        console.log(">>> Waiting 3 seconds before next old order...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    console.log(">>> [final-submit] Step 3: Finding draftOrder by orderId:", orderId);
    const draftOrder = await Order.findOne({ orderId, status: "draft" });
    if (!draftOrder) {
      console.error("Draft order not found for orderId:", orderId);
      return res.status(404).json({ success: false, message: "Draft order not found" });
    }
    if (invoice && invoice.trim() !== "") {
      draftOrder.invoice = invoice;
    }
    draftOrder.emailSubject = emailSubject || "";
    draftOrder.actingReel = actingReel || "";
    draftOrder.resumeLink = resumeLink || "";
    draftOrder.introduction = introduction || "";
    draftOrder.venmoId = venmoId || "";
    draftOrder.status = "final";
    console.log(">>> [final-submit] Step 4: Saving order with status=final to DB");
    await draftOrder.save();
    console.log("✅ Final submission order updated in MongoDB (status=final):", draftOrder);

    // (1) 관리자에게 배우 자료 이메일 전송
    console.log(">>> [final-submit] Step 5: Sending admin email with actor info");
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
    await sendEmailAPI({
      subject: emailSubject || "[No Subject Provided]",
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: process.env.ELASTIC_EMAIL_USER, // 관리자 이메일
      bodyHtml: adminEmailHtml,
      isTransactional: true
    });
    console.log("✅ Admin email sent.");

    // (2) 클라이언트(주문자)에게 인보이스 이메일 전송
    console.log(">>> [final-submit] Step 6: Sending client invoice email");
    const templatePath = path.join(__dirname, "email.html");
    let clientEmailHtml;
    if (fs.existsSync(templatePath)) {
      console.log(">>> email.html found:", templatePath);
      clientEmailHtml = fs.readFileSync(templatePath, "utf-8");
    } else {
      console.error(">>> email.html NOT found at:", templatePath);
      clientEmailHtml = "<html><body><p>Invoice details not available.</p></body></html>";
    }
    clientEmailHtml = clientEmailHtml.replace(/{{\s*invoice\s*}}/g, draftOrder.invoice);
    await sendEmailAPI({
      subject: "[Smart Talent Matcher] Invoice for Your Submission",
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: draftOrder.emailAddress,
      bodyHtml: clientEmailHtml,
      isTransactional: true
    });
    console.log("✅ Client Invoice email sent.");

    // (3) 12시간 리마인드, 24시간 자동 취소, 48시간 자동 삭제 스케줄링
    console.log(">>> [final-submit] Step 7: Scheduling timers for reminder, auto-cancel, and auto-delete");
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);
    scheduleAutoDelete(draftOrder);

    // (4) 최종 응답
    console.log(">>> [final-submit] Step 8: Returning success response");
    return res.json({
      success: true,
      message: "Final submission complete! Admin/client emails sent, timers scheduled."
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    return res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

// ───────── [admin/orders 라우트 - 관리자 조회] ─────────
app.get("/admin/orders", async (req, res) => {
  try {
    console.log(">>> [DEBUG] /admin/orders called.");
    const orders = await Order.find({});
    console.log(">>> [DEBUG] /admin/orders - orders found:", orders);
    return res.json({ success: true, orders });
  } catch (error) {
    console.error("Error in /admin/orders:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [admin/delete-order 라우트 - 관리자 주문 삭제] ─────────
app.post("/admin/delete-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.headshot) {
      const parts = order.headshot.split("/");
      const uploadIndex = parts.findIndex((part) => part === "upload");
      if (uploadIndex !== -1 && parts.length > uploadIndex + 2) {
        const fileNameWithExtension = parts.slice(uploadIndex + 2).join("/");
        const publicId = fileNameWithExtension.replace(/\.[^/.]+$/, "");
        await cloudinary.uploader.destroy(publicId);
      }
    }
    await Order.deleteOne({ orderId });
    res.json({ success: true, message: `Order #${orderId} deleted.` });
  } catch (err) {
    console.error("Error in /admin/delete-order:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// [FIX #1] invoice에서 <span id="selected-names">... </span> 문자열을 깔끔히 파싱
function parseSelectedName(invoiceHtml) {
  if (!invoiceHtml) return "";

  const match = invoiceHtml.match(/<span[^>]*id=["']selected-names["'][^>]*>(.*?)<\/span>/i);
  if (!match || !match[1]) return "";

  // ex) "[Base Package] United States (+Canada) <span style="font-size...($0.005 per email)"
  let text = match[1].trim();

  // 1) <span ...> 태그가 또 들어있는 경우를 잘라냄
  //    ex) remove everything after "<span"
  text = text.replace(/\s*<span.*$/i, "");

  // 2) [Base Package] 부분 제거
  //    ex) "[Base Package] United States (+Canada)"
  //    -> "United States (+Canada)"
  text = text.replace(/\[Base Package\]\s*/, "").trim();

  // 3) 최종 결과 ex) "United States (+Canada)"
  return text;
}

// (대량 메일 전송: Chunk+Delay)
async function sendBulkEmailsInChunks(emails, mailDataTemplate, chunkSize = 20, delayMs = 1000) {
  console.log(">>> [DEBUG] sendBulkEmailsInChunks() called");
  console.log(">>> [DEBUG] total emails to send:", emails.length);
  if (emails.length === 0) {
    console.log(">>> [DEBUG] No emails to send. Exiting sendBulkEmailsInChunks.");
    return;
  }
  let sentCount = 0;
  for (let i = 0; i < emails.length; i += chunkSize) {
    const chunk = emails.slice(i, i + chunkSize);
    console.log(`>>> [DEBUG] Sending chunk from index ${i} to ${i + chunkSize - 1} (chunk size = ${chunk.length})`);
    
    const promises = chunk.map((recipientEmail, idx) => {
      const mailData = { ...mailDataTemplate, to: recipientEmail };
      return sendEmailAPI(mailData)
        .then(() => {
          sentCount++;
          console.log(`✅ [DEBUG] Sent to ${recipientEmail} [${sentCount}/${emails.length}]`);
        })
        .catch(err => {
          console.error(`❌ [DEBUG] Failed to send to ${recipientEmail}`, err);
        });
    });

    await Promise.all(promises);

    if (i + chunkSize < emails.length) {
      console.log(`>>> [DEBUG] Waiting ${delayMs}ms before next chunk...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  console.log("✅ [DEBUG] All bulk emails sent with chunk approach!");
}

// (디버깅) /admin/toggle-payment
app.get("/admin/toggle-payment", async (req, res) => {
  try {
    const { orderId } = req.query;
    console.log(">>> [DEBUG] /admin/toggle-payment called. orderId =", orderId);

    const order = await Order.findOne({ orderId });
    if (!order) {
      console.error(">>> [DEBUG] Order not found for orderId:", orderId);
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    console.log(">>> [DEBUG] Found order:", order);

    const oldPaid = order.paid;
    order.paid = !oldPaid;
    await order.save();
    console.log(`>>> [DEBUG] Toggled paid from ${oldPaid} to ${order.paid}`);

    if (!oldPaid && order.paid) {
      console.log(">>> [DEBUG] Payment changed from false -> true. Will send 'service started' email AND do bulk emailing.");

      // (A) "서비스 시작" 메일
      const startedHtml = `
      <html>
      <body style="font-family: Arial, sans-serif; line-height:1.6;">
        <h2>🎉 Your service has started! 🎉</h2>
        <p>Dear Customer,</p>
        <p>
          We are pleased to inform you that your payment has been successfully processed,
          and your service has now begun.
        </p>
        <p>
          Once all emails corresponding to your selected region have been sent,
          you will receive a confirmation email.
        </p>
        <p>
          Thank you for trusting our service. We are committed to helping you find the right people.
        </p>
        <br>
        <p>Best Regards,<br>Smart Talent Matcher Team</p>
      </body>
      </html>
      `;
      const mailDataStart = {
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        from: process.env.ELASTIC_EMAIL_USER,
        fromName: "Smart Talent Matcher",
        to: order.emailAddress,
        bodyHtml: startedHtml,
        isTransactional: true
      };
      console.log(">>> [DEBUG] Sending service-start email to:", order.emailAddress);
      await sendEmailAPI(mailDataStart);
      console.log("✅ [DEBUG] Service start email sent.");

      // (B) 대량 메일 로직
      console.log(">>> [DEBUG] Starting Bulk Email Logic...");

      const selectedName = parseSelectedName(order.invoice); // 여기서 불필요 HTML 제거
      console.log(">>> [DEBUG] selectedName =", selectedName);

      if (!selectedName) {
        console.log(">>> [DEBUG] selectedName is empty. Skipping bulk emailing.");
      } else {
        // 가령 BulkEmailRecipient에 countryOrSource: "United States (+Canada)" 로 저장돼 있어야 매칭됨
        console.log(">>> [DEBUG] Finding recipients matching selectedName...");
        const recipients = await BulkEmailRecipient.find({ 
          // countryOrSource: selectedName 
          // 실제로는 위 처럼 스키마에 countryOrSource를 넣어야 정확히 찾음
        });
        console.log(">>> [DEBUG] BulkEmailRecipient found:", recipients.length, "docs.");

        if (recipients.length === 0) {
          console.log(">>> [DEBUG] No recipients matched. Bulk emailing aborted.");
        } else {
          const emails = [
            ...new Set(recipients.map(r => (r.email || "").trim().toLowerCase()))
          ].filter(e => e);
          console.log(">>> [DEBUG] uniqueEmails after dedup =", emails.length);

          const formattedIntro = order.introduction
            ? order.introduction.replace(/\r?\n/g, "<br>")
            : "";
          let emailHtml = `<div style="font-family: Arial, sans-serif;">`;
          if (order.headshot) {
            emailHtml += `
              <div>
                <img src="${order.headshot}" style="max-width:600px; width:100%; height:auto;" alt="Headshot" />
              </div>
              <br>
            `;
          }
          emailHtml += `
            <p><strong>Acting Reel:</strong> <a href="${order.actingReel}" target="_blank">${order.actingReel}</a></p>
            <p><strong>Resume:</strong> <a href="${order.resumeLink}" target="_blank">${order.resumeLink}</a></p>
            <br>
            <p>${formattedIntro}</p>
          `;
          emailHtml += `</div>`;

          const bulkMailDataTemplate = {
            subject: order.emailSubject || "[No Subject Provided]",
            from: process.env.ELASTIC_EMAIL_USER,
            fromName: "",
            bodyHtml: emailHtml,
            isTransactional: false
          };

          console.log(">>> [DEBUG] Starting to send Bulk Emails in Chunks...");
          await sendBulkEmailsInChunks(emails, bulkMailDataTemplate, 20, 1000);
          console.log("✅ [DEBUG] Bulk emailing completed!");
        }
      }
    } else {
      console.log(">>> [DEBUG] Payment either remains false or toggled true->false. No mailing logic triggered.");
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("❌ [DEBUG] Error in /admin/toggle-payment:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});
// ───────── [서버 리슨 및 초기 정리 작업] ─────────
// ⬇️ [CHANGED] Render가 포트 개방 여부를 인식할 수 있도록 "0.0.0.0"로 바인딩
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  uploadCSVToDB()
    .then(() => {
      console.log("Bulk email recipients updated from CSV (Full Refresh).");
      restoreTimers();               
      cleanUpIncompleteOrders();     
      syncCloudinaryWithDB();        
      cleanUpNonFinalOrders();       
    })
    .catch(err => {
      console.error("Error uploading CSV to DB:", err);
      restoreTimers();
      cleanUpIncompleteOrders();
      syncCloudinaryWithDB();
      cleanUpNonFinalOrders();
    });
});