//
// server.js (ESM 버전) - 12시간 리마인드 + 24시간 자동취소 + CSV → DB 자동 업로드 + 대량 이메일 발송
//

// --------------------------------------------
// [환경변수 설정: .env 불러오기]
import dotenv from "dotenv";
dotenv.config();

// --------------------------------------------
// [필요한 패키지/모듈 import]
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import juice from "juice"; // (현재 사용 안 하는 유틸. 필요 시 사용)
import cors from "cors";
import mongoose from "mongoose";
import fetch from "node-fetch";
import csvParser from "csv-parser"; // npm install csv-parser

// --------------------------------------------
// [Cloudinary 관련 모듈 (v2)]
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

// --------------------------------------------
// [form-data (ESM 방식)]
import FormData from "form-data";

// --------------------------------------------
// [HTTPS (기타 API 호출 시 TLS 옵션 설정용)]
import https from "https";

// --------------------------------------------
// [ESM 환경에서 __dirname 생성]
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------
// [Cloudinary 설정 및 Storage 구성]
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

// --------------------------------------------
// [MongoDB 연결 및 Mongoose 모델 정의]
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB Atlas"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

//
// [Order 스키마/모델 정의]
//
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

// --------------------------------------------
// [BulkEmailRecipient 스키마 & 모델 정의]
//   (이메일 + 나라) 정보를 함께 저장하여 중복 관리하기
// --------------------------------------------
const bulkEmailRecipientSchema = new mongoose.Schema({
  email: { type: String, required: true },
  countryOrSource: { type: String, default: "" }
});

// 🍀 (email, countryOrSource) 복합 unique 인덱스
bulkEmailRecipientSchema.index({ email: 1, countryOrSource: 1 }, { unique: true });

const BulkEmailRecipient = mongoose.model("BulkEmailRecipient", bulkEmailRecipientSchema);

// --------------------------------------------
// [CSV 파일을 읽어들여서 DB에 업로드하는 함수]
//   - 서버 시작 시 한 번 or 필요할 때마다 호출
// --------------------------------------------
function uploadCSVToDB() {
  return new Promise((resolve, reject) => {
    // 🍀 변경점 ①: CSV 폴더를 __dirname 기준 ./csv 로 설정
    const csvFolderPath = path.join(__dirname, "csv");

    fs.readdir(csvFolderPath, (err, files) => {
      if (err) return reject(err);

      // 🍀 확장자가 .csv 인 파일만 필터링
      const csvFiles = files.filter(file => file.endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }

      let filesProcessed = 0;

      // 🍀 폴더 내 CSV 파일을 순회
      csvFiles.forEach(async (file) => {
        // 나라/출처 식별용 이름 (파일명에서 .csv 제거)
        const fileNameWithoutExt = file.replace(".csv", "");

        // (선택) 기존 문서 중 countryOrSource가 동일한 것 삭제
        await BulkEmailRecipient.deleteMany({ countryOrSource: fileNameWithoutExt });

        const upsertPromises = [];
        fs.createReadStream(path.join(csvFolderPath, file))
          // 🍀 변경점 ②: CSV 헤더가 없으므로 headers: ["email"] 지정
          .pipe(csvParser({ headers: ["email"] }))
          .on("data", (row) => {
            // 🍀 이제 row.email 이 각 라인에 담긴 값
            //     "Email" 헤더가 없는 대신, 임의로 'email' 이라는 필드를 부여
            if (row.email) {
              upsertPromises.push(
                BulkEmailRecipient.updateOne(
                  {
                    email: row.email.trim(),
                    countryOrSource: fileNameWithoutExt
                  },
                  {
                    email: row.email.trim(),
                    countryOrSource: fileNameWithoutExt
                  },
                  { upsert: true }
                )
              );
            }
          })
          .on("end", async () => {
            try {
              await Promise.all(upsertPromises);
              filesProcessed++;
              if (filesProcessed === csvFiles.length) {
                console.log("✅ All CSV files uploaded to DB (with countryOrSource).");
                resolve();
              }
            } catch (err) {
              reject(err);
            }
          })
          .on("error", (err) => reject(err));
      });
    });
  });
}

// --------------------------------------------
// [Express 앱 및 미들웨어 설정]
const app = express();
const PORT = process.env.PORT || 3000;

// 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// 정적 파일 제공
app.use(express.static(__dirname));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --------------------------------------------
// [유틸리티 함수: 날짜 기반 Order ID 생성]
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

// --------------------------------------------
// [Elastic Email API를 이용한 이메일 발송 함수]
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

// --------------------------------------------
// [타이머 관련 상수 & 변수]
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const reminderTimers = {};
const autoCancelTimers = {};

// --------------------------------------------
// [12시간 후 리마인드 이메일 스케줄링]
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

// --------------------------------------------
// [24시간 후 자동취소 이메일 스케줄링]
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
  const mailData = {
    subject: "[Smart Talent Matcher] Invoice Auto-Canceled (24h Passed)",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: cancelHtml,
    isTransactional: true
  };

  sendEmailAPI(mailData)
    .then(async (data) => {
      console.log(`🚨 Auto-cancel email sent for #${order.orderId}:`, data);
      await Order.deleteOne({ orderId: order.orderId, status: order.status });
      console.log(`Order #${order.orderId} removed from DB.`);
    })
    .catch((err) => console.error("❌ Error sending auto-cancel:", err));
}

// --------------------------------------------
// [서버 시작 시, 미결제 final 주문들에 대해 리마인더/자동취소 스케줄 복원]
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

// --------------------------------------------
// [라우트 설정 예시]
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

//
// [테스트 이메일 전송 라우트]
//
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

//
// [draft(임시) 주문 생성 라우트]
//
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

//
// [draft(임시) 주문 업데이트 라우트]
//
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

//
// [draft → final 제출 라우트]
//
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log("Final submit received:", req.body);

    // 이미 "final" 상태의 (paid되지 않은) 중복 주문 찾아서 모두 취소
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

        // 3초 대기
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // 현재 draftOrder 찾아서 final 전환
    const draftOrder = await Order.findOne({ orderId, status: "draft" });
    if (!draftOrder) {
      return res.status(404).json({ success: false, message: "Draft order not found" });
    }

    if (invoice && invoice.trim() !== "") {
      draftOrder.invoice = invoice;
    }

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

    // [관리자에게 배우 자료 이메일]
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
      to: process.env.ELASTIC_EMAIL_USER,
      bodyHtml: adminEmailHtml,
      isTransactional: true
    });
    console.log("✅ Admin email sent.");

    // [클라이언트 인보이스 이메일]
    const templatePath = path.join(__dirname, "email.html");
    let clientEmailHtml = fs.existsSync(templatePath)
      ? fs.readFileSync(templatePath, "utf-8")
      : "<html><body><p>Invoice details not available.</p></body></html>";
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

    // [12시간 리마인드, 24시간 자동취소 스케줄링]
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);

    // [대량 이메일 발송: BulkEmailRecipient]
    const bulkSender = draftOrder.emailAddress; 
    const recipientsFromDB = await BulkEmailRecipient.find({});
    if (recipientsFromDB.length === 0) {
      console.error("No bulk email recipients found in DB.");
    } else {
      const recipientEmails = recipientsFromDB.map(r => r.email).join(",");
      const bulkResult = await sendEmailAPI({
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        from: bulkSender,
        fromName: "Smart Talent Matcher",
        to: recipientEmails,
        bodyHtml: clientEmailHtml,
        isTransactional: true
      });
      console.log("Bulk Email API Response:", bulkResult);
      if (bulkResult.success) {
        console.log("✅ Bulk email sent successfully:", bulkResult);
      } else {
        console.error("❌ Bulk email sending failed:", bulkResult.message);
      }
    }

    res.json({
      success: true,
      message: "Final submission complete! Emails sent, reminders scheduled, and bulk email campaign started."
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

//
// [관리자 페이지: 전체 final 주문 조회 라우트]
//
app.get("/admin/orders", async (req, res) => {
  try {
    const now = Date.now();
    const orders = await Order.find({ status: "final" });
    const processedOrders = orders.map((order) => {
      const timeSinceCreation = now - order.createdAt.getTime();
      const expired = (!order.paid && timeSinceCreation >= 24 * 60 * 60 * 1000) ? "24hrs" : "";
      return { ...order.toObject(), expired };
    });

    // 48시간 지난 미결제 오더 삭제
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

//
// [관리자 페이지: 특정 final 주문을 강제 삭제(취소)]
//
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
    await sendEmailAPI({
      subject: "[Smart Talent Matcher] Invoice Canceled (Admin)",
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: emailAddress,
      bodyHtml: cancelHtml,
      isTransactional: true
    });

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

//
// [관리자 페이지: 결제 상태 토글 라우트]
//
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

//
// [서버 시작 시, final이 아닌 주문들 정리(Cloudinary 파일 포함)]
//
const cleanUpNonFinalOrders = async () => {
  try {
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

// --------------------------------------------
// [서버 리슨 시작]
//   - CSV 업로드 후
//   - 리마인더/자동취소 타이머 복원
//   - draft 정리
// --------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running at ${process.env.SERVER_URL || "http://localhost:" + PORT}`);

  uploadCSVToDB()
    .then(() => {
      console.log("Bulk email recipients updated from CSV.");
      restoreTimers();
      cleanUpNonFinalOrders();
    })
    .catch(err => {
      console.error("Error uploading CSV to DB:", err);
      restoreTimers();
      cleanUpNonFinalOrders();
    });
});