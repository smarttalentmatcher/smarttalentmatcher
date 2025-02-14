//
// server.js (ESM 버전) - debug용 전체 코드 (admin/orders 디버깅)
//

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

// 🍀 CHANGED: DB 연결 과정에서 환경변수 로그 추가
console.log(">>>> [DEBUG] MONGO_URI =", MONGO_URI);

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Atlas (or local)");
    // 🍀 CHANGED: 연결된 DB 이름 출력 (mongoose.connection.name은 DB명이 맞지 않을 수 있으니, 한번 콘솔로 찍어보겠습니다.)
    console.log(">>>> [DEBUG] DB Name (via mongoose.connection.name) =", mongoose.connection.name);
  })
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

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
    const csvFolderPath = "/Users/kimsungah/Desktop/SmartTalentMatcher/csv";
    fs.readdir(csvFolderPath, (err, files) => {
      if (err) return reject(err);
      const csvFiles = files.filter(file => file.endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }
      BulkEmailRecipient.deleteMany({})
        .then(() => {
          let filesProcessed = 0;
          csvFiles.forEach(file => {
            const filePath = path.join(csvFolderPath, file);
            fs.createReadStream(filePath)
              .pipe(csvParser())
              .on("data", (row) => {
                if (row.email) {
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

// ───────── [타이머 관련 상수 & 변수] ─────────
const TWELVE_HOURS = 1 * 60 * 1000;
const TWENTY_FOUR_HOURS = 2 * 60 * 1000;
const reminderTimers = {};
const autoCancelTimers = {};

// ───────── [12시간 후 리마인드 & 전송 함수] ─────────
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

// ───────── [24시간 후 자동취소 이메일 스케줄링] ─────────
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
<!-- 테이블 100% 폭, 안쪽에 단일 row/column 가운데 정렬 -->
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
              We noticed you haven't completed your payment within 24 hours, <br>
              so your invoice for <strong>Order #${order.orderId}</strong> has been 
              <strong>automatically canceled</strong>.
            </p>
            <br>
            <p style="margin:0 0 15px 0;">
              However, we don't want you to miss out on this great opportunity.<br>
              If you've been on the fence, we'd like to offer you a second chance <br>
              with a special <strong>10% discount</strong> using our promo code:
            </p>

            <p style="color:#28a745; font-weight:bold; margin:0 0 10px 0;">
              This discount code helps you save 10% on your next order!
            </p>

            <!-- 프로모 코드 영역 (초록색 박스) -->
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
              Simply apply this code when creating a new order.<br>
              Re-submit your order now and take advantage of this discount while it lasts!
            </p>
            <br><br>
            <!-- CTA 버튼 -->
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

  // ...
}
// ───────── [서버 시작 시, 미결제 final 주문 리마인더/자동취소 복원] ─────────
async function restoreTimers() {
  try {
    const pendingOrders = await Order.find({ status: "final", paid: false });
    console.log(`>>> [DEBUG] restoreTimers: found ${pendingOrders.length} final/pending orders.`);
    pendingOrders.forEach((order) => {
      if (!order.reminderSent) scheduleReminder(order);
      scheduleAutoCancel(order);
    });
    console.log(`✅ Restored ${pendingOrders.length} orders with pending reminders and cancellations.`);
  } catch (err) {
    console.error("❌ Error restoring timers:", err);
  }
}

// ───────── [라우트 설정] ─────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

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

app.post("/update-order", uploadHeadshot.single("headshot"), async (req, res) => {
  try {
    const {
      orderId,
      emailAddress,
      emailSubject,
      actingReel,
      resumeLink,
      introduction,
      invoice
    } = req.body;
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

// [draft → final 제출 라우트]
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    console.log(">>> [final-submit] Step 0: Endpoint called");

    const {
      orderId,
      emailAddress,
      emailSubject,
      actingReel,
      resumeLink,
      introduction,
      invoice,
      venmoId
    } = req.body;
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
      to: process.env.ELASTIC_EMAIL_USER, // 관리자(운영자) 이메일
      bodyHtml: adminEmailHtml,
      isTransactional: true
    });
    console.log("✅ Admin email sent.");

    // (2) 클라이언트(주문자)에게 인보이스 이메일
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

    // (3) 12시간 리마인드 / 24시간 자동취소 스케줄링
    console.log(">>> [final-submit] Step 7: Scheduling reminder & auto-cancel timers");
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);

    // (4) 최종 응답
    console.log(">>> [final-submit] Step 8: Returning success response");
    return res.json({
      success: true,
      message: "Final submission complete! Admin/client emails sent, reminders scheduled."
    });

  } catch (error) {
    console.error("❌ Error in final submission:", error);
    return res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

// ───────── [admin/orders 라우트 - 관리자 조회] ─────────
app.get("/admin/orders", async (req, res) => {
  try {
    // 🍀 CHANGED: 디버깅용 로그 추가
    console.log(">>> [DEBUG] /admin/orders called.");

    const orders = await Order.find({});
    // 🍀 CHANGED: 어떤 결과가 나오는지 콘솔 출력
    console.log(">>> [DEBUG] /admin/orders - orders found:", orders);

    return res.json({ success: true, orders });
  } catch (error) {
    console.error("Error in /admin/orders:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

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

app.get("/admin/toggle-payment", async (req, res) => {
  try {
    const { orderId } = req.query;
    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    order.paid = !order.paid;
    await order.save();
    res.json({ success: true, order });
  } catch (error) {
    console.error("Error in /admin/toggle-payment:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [cleanUpNonFinalOrders & 서버 리슨] ─────────
const cleanUpNonFinalOrders = async () => {
  // 필요시 구현
};

app.listen(PORT, () => {
  console.log(`✅ Server running at ${process.env.SERVER_URL || "http://localhost:" + PORT}`);
  uploadCSVToDB()
    .then(() => {
      console.log("Bulk email recipients updated from CSV (Full Refresh).");
      restoreTimers();
      cleanUpNonFinalOrders();
    })
    .catch(err => {
      console.error("Error uploading CSV to DB:", err);
      restoreTimers();
      cleanUpNonFinalOrders();
    });
});