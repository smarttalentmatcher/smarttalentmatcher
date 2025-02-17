// --------------------------------------------------------------------------------
// SERVER.JS (ESM 버전) - 전체 코드 (MODIFIED FINAL)
//  + 2주(TWO_WEEKS) 팔로업 메일 + 타이머 복원
//  + Review (CRUD) 기능 추가
//  + Paid 상태 재확인 (12h/24h 메일 발송 전) 수정 완료
//  + [FIX] 결제 이전에는 대량 메일·2주 팔로업이 발송되지 않도록 수정
//  + [ADDED] 웹훅 삭제 라우트 및 삭제 동기화 기능 추가
// --------------------------------------------------------------------------------

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

// __filename, __dirname 설정
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

// ───────── [Order 스키마 정의] ─────────
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
  status: { type: String, default: "draft" },
  bulkEmailsCompletedAt: { type: Date, default: null },
  twoWeekFollowUpSent: { type: Boolean, default: false }
});
const Order = mongoose.model("Order", orderSchema);

// ───────── [BulkEmailRecipient 스키마 정의] ─────────
const bulkEmailRecipientSchema = new mongoose.Schema({
  email: { type: String, required: true },
  countryOrSource: { type: String, default: "" }
});
const BulkEmailRecipient = mongoose.model("BulkEmailRecipient", bulkEmailRecipientSchema);

// ───────── [Review 스키마 정의] ─────────
const reviewSchema = new mongoose.Schema({
  reviewText: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const Review = mongoose.model("Review", reviewSchema);

// ───────── [EmailEvent 스키마 (웹훅)] ─────────
const emailEventSchema = new mongoose.Schema({
  eventType: { type: String, default: "" },
  data: { type: mongoose.Schema.Types.Mixed },
  receivedAt: { type: Date, default: Date.now }
});
const EmailEvent = mongoose.model("EmailEvent", emailEventSchema);

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

// ───────── [Elastic Email 메일발송 함수 (Reply-To, extraTag)] ─────────
async function sendEmailAPI({
  subject,
  from,
  fromName,
  to,
  bodyHtml,
  isTransactional = true,
  replyTo,
  replyToName,
  extraTag
}) {
  const url = "https://api.elasticemail.com/v2/email/send";
  const params = new URLSearchParams();

  params.append("apikey", process.env.ELASTIC_EMAIL_API_KEY);
  params.append("subject", subject);
  params.append("from", from || process.env.ELASTIC_EMAIL_USER);
  params.append("fromName", fromName || "");
  params.append("to", to);
  params.append("bodyHtml", bodyHtml);
  params.append("isTransactional", isTransactional ? "true" : "false");

  if (replyTo) {
    params.append("replyTo", replyTo);
  }
  if (replyToName) {
    params.append("replyToName", replyToName);
  }

  if (extraTag) {
    // [MODIFIED] extraTag 값을 merge_extratag, X-ExtraTag 헤더와 함께 category에도 설정
    params.append("merge_extratag", extraTag);
    params.append("headers", `X-ExtraTag: ${extraTag}`);
    params.append("category", extraTag);
  }

  try {
    const response = await fetch(url, { method: "POST", body: params });
    const data = await response.json();
    return data;
  } catch (err) {
    console.error("Error sending email via API:", err);
    throw err;
  }
}

// ───────── [CSV 파일 → BulkEmailRecipient DB 업로드] ─────────
function uploadCSVToDB() {
  return new Promise((resolve, reject) => {
    const csvFolderPath = path.join(__dirname, "csv");
    console.log(">>> [CSV Import] Target folder =", csvFolderPath);

    if (!fs.existsSync(csvFolderPath)) {
      console.log(`No CSV folder found at: ${csvFolderPath}. Skipping CSV import.`);
      return resolve();
    }

    fs.readdir(csvFolderPath, (err, files) => {
      if (err) return reject(err);

      const csvFiles = files.filter(file => file.toLowerCase().endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }

      console.log(`[CSV Import] Found ${csvFiles.length} CSV file(s):`, csvFiles);

      BulkEmailRecipient.deleteMany({})
        .then(() => {
          let filesProcessed = 0;
          csvFiles.forEach(file => {
            const filePath = path.join(csvFolderPath, file);
            const regionName = path.basename(file, ".csv");
            let insertedCountThisFile = 0;
            fs.createReadStream(filePath)
              .pipe(csvParser({ headers: ["email"], skipLines: 1, bom: true }))
              .on("data", async (row) => {
                const emailVal = row.email;
                if (emailVal && emailVal.trim() !== "") {
                  try {
                    await BulkEmailRecipient.create({
                      email: emailVal.trim(),
                      countryOrSource: regionName,
                    });
                    insertedCountThisFile++;
                  } catch (err) {
                    console.error("Error inserting email:", err);
                  }
                }
              })
              .on("end", async () => {
                filesProcessed++;
                console.log(`[CSV DEBUG] File '${file}' => insertedCountThisFile = ${insertedCountThisFile}`);
                if (filesProcessed === csvFiles.length) {
                  const totalDocs = await BulkEmailRecipient.countDocuments();
                  console.log(`CSV files uploaded to DB. Total BulkEmailRecipient docs = ${totalDocs}`);
                  resolve();
                }
              })
              .on("error", (err) => {
                console.error("Error reading CSV file:", file, err);
                reject(err);
              });
          });
        })
        .catch(err => reject(err));
    });
  });
}

// ───────── [테스트 라우트] ─────────
app.get("/", (req, res) => {
  res.send("<h1>Hello from server.js - CSV Reload test</h1>");
});

// ───────── [타이머 관련 (테스트용 1/2/3분)] ─────────
const TWELVE_HOURS = 1 * 60 * 1000;    // 실제 12시간 → 테스트 1분
const TWENTY_FOUR_HOURS = 2 * 60 * 1000; // 실제 24시간 → 테스트 2분
const FORTY_EIGHT_HOURS = 3 * 60 * 1000; // 실제 48시간 → 테스트 3분
const TWO_WEEKS = 1 * 60 * 1000;       // 실제 2주 → 테스트 1분

const reminderTimers = {};
const autoCancelTimers = {};
const autoDeleteTimers = {};
const twoWeekTimers = {};

// 12h 리마인더
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
  Order.findOne({ orderId: order.orderId })
    .then(savedOrder => {
      if (!savedOrder) {
        console.error(`❌ Order #${order.orderId} not found in DB for reminder.`);
        return;
      }
      if (savedOrder.paid || savedOrder.reminderSent) {
        console.log(`>>> [Reminder] Order #${order.orderId} is paid or reminderSent=true. Skipping reminder.`);
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
        isTransactional: true,
        extraTag: "12hrsReminder"
      };
      sendEmailAPI(mailData)
        .then(data => {
          console.log(`✅ Reminder email sent for #${savedOrder.orderId}:`, data);
          savedOrder.reminderSent = true;
          return savedOrder.save();
        })
        .catch(err => console.error("❌ Error sending reminder:", err));
    })
    .catch(err => console.error("❌ DB Error in sendReminder:", err));
}

// 24h Auto-Cancel
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
  Order.findOne({ orderId: order.orderId })
    .then(savedOrder => {
      if (!savedOrder) {
        console.error(`❌ Order #${order.orderId} not found in DB for auto-cancel.`);
        return;
      }
      if (savedOrder.paid) {
        console.log(`>>> [AutoCancel] Order #${order.orderId} is paid. Skipping auto-cancel.`);
        return;
      }
      const cancelHtml = `
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
            <div style="font-size: 1.4rem; font-weight: bold; background:#28a745; color:#ffffff; border-radius:8px; display:inline-block; padding:10px 20px; margin:15px 0;">
              WELCOME10
            </div>
            <p style="margin:15px 0 20px 0;">
              Simply apply this code when creating a new order.
            </p>
            <br><br>
            <a 
              href="https://smarttalentmatcher.com" 
              target="_blank" 
              style="display: inline-block; background: #00BCD4; color: #FFFFFF; padding: 20px 40px; font-size: 1.5rem; font-weight: bold; font-style: italic; border-radius: 30px; border: 4px solid #001f3f; transition: background 0.3s ease; box-shadow: 0 8px 12px rgba(0,0,0,0.4); text-decoration: none;"
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
        isTransactional: true,
        extraTag: "24hrsAutoCancel+promo"
      };
      sendEmailAPI(mailData)
        .then(data => {
          console.log(`✅ Auto-cancel email sent for #${order.orderId}:`, data);
        })
        .catch(err => console.error("❌ Error sending auto-cancel email:", err));
    })
    .catch(err => console.error("❌ DB Error in autoCancelOrder:", err));
}

// 48h Auto-Delete
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
  const currentOrder = await Order.findOne({ orderId: order.orderId });
  if (!currentOrder) {
    console.error(`Order #${order.orderId} not found during auto-delete check.`);
    return;
  }
  if (currentOrder.paid) {
    console.log(`Order #${order.orderId} is paid. Skipping auto-delete.`);
    return;
  }
  console.log(`>>> autoDeleteOrder called for order #${order.orderId}`);
  if (currentOrder.headshot) {
    const parts = currentOrder.headshot.split("/");
    const uploadIndex = parts.findIndex(part => part === "upload");
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
  try {
    await Order.deleteOne({ orderId: currentOrder.orderId });
    console.log(`✅ Order #${currentOrder.orderId} auto-deleted from DB after 48 hours.`);
  } catch (err) {
    console.error("Error auto-deleting order from DB:", err);
  }
}

// 2주 팔로업
function scheduleTwoWeekFollowUpEmail(order) {
  if (order.twoWeekFollowUpSent) return;
  if (!order.bulkEmailsCompletedAt) {
    console.log(">>> [DEBUG] bulkEmailsCompletedAt not set. Cannot schedule 2-week follow-up for", order.orderId);
    return;
  }
  if (twoWeekTimers[order.orderId]) {
    clearTimeout(twoWeekTimers[order.orderId]);
    delete twoWeekTimers[order.orderId];
  }
  const timePassed = Date.now() - order.bulkEmailsCompletedAt.getTime();
  const timeLeft = TWO_WEEKS - timePassed;
  if (timeLeft <= 0) {
    sendTwoWeekEmail(order);
    return;
  }
  twoWeekTimers[order.orderId] = setTimeout(() => {
    sendTwoWeekEmail(order);
  }, timeLeft);
  console.log(`⏰ Scheduled 2-week follow-up email for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
}

async function sendTwoWeekEmail(order) {
  const twoWeekHtml = `
<table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; background-color:#f9f9f9; color:#333; line-height:1.6;">
  <tr>
    <td align="center" style="padding: 30px;">
      <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff; border-radius:8px; padding:20px;">
        <tr>
          <td align="center" style="padding: 20px;">
            <h2 style="color:#d9534f; margin-top:0;">
              It's Been 2 Weeks. How Are You Doing?
            </h2>
            <br><br>
            <p style="margin:0 0 15px 0;">
              Hello ${order.emailAddress ? order.emailAddress.split("@")[0] : ""},
            </p>
            <br>
            <p style="margin:0 0 15px 0;">
              We hope you've found <span style="color:royalblue;">the Right Person</span>.<br><br>
              💡 Check which <strong>platform</strong> they use and the <strong>regions</strong> they have access to for breakdown services.<br>
              💡 Verify whether the contract is <strong>Exclusive</strong> or <strong>Non-Exclusive</strong>.<br>
              💡 Always <strong>REVIEW</strong> any contracts before signing<br>
              (ask ChatGPT for help if needed)!<br><br><br>
              However, <strong>if not,</strong> <span style="color:royalblue;">Don't Be Discouraged!</span><br>
              You can always <strong>update your materials and try again.</strong><br>
              (I personally tried <strong>2 times</strong> before success!)
            </p>
            <br>
            <p style="margin:0 0 15px 0;">
              Use the promo code below to get <strong>10% off on your Next Trial!</strong>
            </p>
            <div style="font-size: 1.4rem; font-weight: bold; background:#28a745; color:#ffffff; border-radius:8px; display:inline-block; padding:10px 20px; margin:15px 0;">
              RETURN10
            </div>
            <br><br>
            <p style="margin:15px 0 20px 0;">
              We’d also love to hear your <span style="color:royalblue;">Feedback!</span><br>
              Whether you succeeded or faced challenges,<br>
              your thoughts help us improve.
            </p>
            <a 
              href="https://smarttalentmatcher.com/review.html"
              target="_blank" 
              style="display: inline-block; background: #00BCD4; color: #FFFFFF; padding: 20px 40px; font-size: 1.5rem; font-weight: bold; font-style: italic; border-radius: 30px; border: 4px solid #001f3f; transition: background 0.3s ease; box-shadow: 0 8px 12px rgba(0,0,0,0.4); text-decoration: none;"
              rel="noopener noreferrer"
            >
              REVIEW
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
  const mailDataFollowUp = {
    subject: "[Smart Talent Matcher] Two-Week Follow-Up",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: twoWeekHtml,
    isTransactional: true,
    extraTag: "2weeksFollowUp"
  };
  try {
    console.log(">>> [DEBUG] Sending 2-week follow-up email to:", order.emailAddress);
    await sendEmailAPI(mailDataFollowUp);
    order.twoWeekFollowUpSent = true;
    await order.save();
    console.log("✅ [DEBUG] 2-week follow-up email sent & order updated.");
  } catch (err) {
    console.error("❌ [DEBUG] Error sending 2-week follow-up email:", err);
  }
}

// ───────── [웹훅 이벤트 삭제 API] ─────────
app.post("/api/webhook-events/delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No IDs provided." });
    }
    // [MODIFIED] id 문자열들을 ObjectId로 변환 후 삭제
    const objectIds = ids.map(id => mongoose.Types.ObjectId(id));
    await EmailEvent.deleteMany({ _id: { $in: objectIds } });

    // [MODIFIED] 삭제된 이벤트 ID들을 "deletedEvents.json" 파일에 저장 (기록)
    const deletedFile = path.join(__dirname, "deletedEvents.json");
    let deletedIds = [];
    if (fs.existsSync(deletedFile)) {
      try {
        deletedIds = JSON.parse(fs.readFileSync(deletedFile, "utf8"));
      } catch (e) {
        deletedIds = [];
      }
    }
    const newDeletedIds = [...new Set([...deletedIds, ...ids])];
    fs.writeFileSync(deletedFile, JSON.stringify(newDeletedIds));

    return res.json({ success: true });
  } catch (err) {
    console.error("Error deleting events:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [서버 시작 및 초기 작업] ─────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  
  // [MODIFIED] 어드민에서 삭제한 이벤트를 DB에서 동기화하는 함수
  async function syncDeletedWebhookEvents() {
    const deletedFile = path.join(__dirname, "deletedEvents.json");
    if (fs.existsSync(deletedFile)) {
      try {
        const deletedIds = JSON.parse(fs.readFileSync(deletedFile, "utf8"));
        if (deletedIds.length > 0) {
          const objectIds = deletedIds.map(id => mongoose.Types.ObjectId(id));
          const result = await EmailEvent.deleteMany({ _id: { $in: objectIds } });
          console.log(`Synced deleted events: ${result.deletedCount} events removed from DB.`);
        }
        // 파일 비우기
        fs.writeFileSync(deletedFile, JSON.stringify([]));
      } catch (e) {
        console.error("Error syncing deleted webhook events:", e);
      }
    }
  }
  
  uploadCSVToDB()
    .then(() => {
      console.log("Bulk email recipients updated from CSV (Full Refresh).");
      restoreTimers();
      cleanUpIncompleteOrders();
      syncCloudinaryWithDB();
      cleanUpNonFinalOrders();
      syncDeletedWebhookEvents(); // [MODIFIED] 삭제 동기화 실행
    })
    .catch(err => {
      console.error("Error uploading CSV to DB:", err);
      restoreTimers();
      cleanUpIncompleteOrders();
      syncCloudinaryWithDB();
      cleanUpNonFinalOrders();
      syncDeletedWebhookEvents(); // [MODIFIED] 에러 발생 시에도 삭제 동기화 실행
    });
});

// ───────── [웹훅 라우트] ─────────
app.all("/webhook", async (req, res) => {
  let eventData;
  if (req.method === "GET") {
    eventData = req.query;
    console.log(">>> [GET] Webhook from Elastic Email:", req.query);
  } else if (req.method === "POST") {
    eventData = req.body;
    console.log(">>> [POST] Webhook from Elastic Email:", req.body);
  }
  try {
    const eventType = eventData.event || "";
    await EmailEvent.create({ eventType, data: eventData });
    console.log("Webhook event saved to DB.");
  } catch (err) {
    console.error("Error saving webhook event:", err);
  }
  res.sendStatus(200);
});

// ───────── [웹훅 이벤트 조회 API] ─────────
app.get("/api/webhook-events", async (req, res) => {
  try {
    const events = await EmailEvent.find({}).sort({ receivedAt: -1 });
    res.json({ success: true, events });
  } catch (err) {
    console.error("Error fetching webhook events:", err);
    res.status(500).json({ success: false, message: "Error fetching webhook events" });
  }
});