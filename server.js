// --------------------------------------------------------------------------------
// SERVER.JS (ESM 버전) - 전체 코드
//  + 1주(ONE_WEEK) / 2주(TWO_WEEKS) 팔로업 메일 + 타이머 복원
//  + Review (CRUD) 기능 추가
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

// 주문(Order) 스키마
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

  // ───────── (추가) 대량 메일 완료 시점 & 팔로업 메일 전송 여부 ─────────
  bulkEmailsCompletedAt: { type: Date, default: null },
  oneWeekFollowUpSent: { type: Boolean, default: false },
  twoWeekFollowUpSent: { type: Boolean, default: false }
});
const Order = mongoose.model("Order", orderSchema);

// 이메일 수신자 (BulkEmailRecipient) 스키마
const bulkEmailRecipientSchema = new mongoose.Schema({
  email: { type: String, required: true },
  countryOrSource: { type: String, default: "" }
});
const BulkEmailRecipient = mongoose.model("BulkEmailRecipient", bulkEmailRecipientSchema);

// (추가) 리뷰(Review) 스키마
const reviewSchema = new mongoose.Schema({
  reviewText: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const Review = mongoose.model("Review", reviewSchema);

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

// ───────── [Elastic Email 메일발송 함수 - Reply-To 지원] ─────────
async function sendEmailAPI({
  subject,
  from,
  fromName,
  to,
  bodyHtml,
  isTransactional = true,
  replyTo,
  replyToName
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
              .pipe(
                csvParser({
                  headers: ["email"],
                  skipLines: 1,
                  bom: true
                })
              )
              .on("data", async (row) => {
                console.log(`[CSV DEBUG] raw row from ${file}:`, row);
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

// ───────── [타이머 관련 상수 & 변수] ─────────
const TWELVE_HOURS = 12 * 60 * 60 * 1000; // 12 * 60 * 60 * 1000
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; //24 * 60 * 60 * 1000
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000; //48 * 60 * 60 * 1000
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;  // 1주 7 * 24 * 60 * 60 * 1000
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000; // 2주 14 * 24 * 60 * 60 * 1000

// 타이머 기록용 객체
const reminderTimers = {};
const autoCancelTimers = {};
const autoDeleteTimers = {};
const oneWeekTimers = {};  
const twoWeekTimers = {}; 

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
  if (order.headshot) {
    const parts = order.headshot.split("/");
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
    await Order.deleteOne({ orderId: order.orderId });
    console.log(`✅ Order #${order.orderId} auto-deleted from DB after 48 hours.`);
  } catch (err) {
    console.error("Error auto-deleting order from DB:", err);
  }
}

// ───────── [1주 / 2주 팔로업 메일: 스케줄 및 발송 함수] ─────────
function scheduleOneWeekFollowUpEmail(order) {
  // 이미 보냈거나 bulkEmailsCompletedAt 없으면 skip
  if (order.oneWeekFollowUpSent) return;
  if (!order.bulkEmailsCompletedAt) {
    console.log(">>> [DEBUG] bulkEmailsCompletedAt not set. Cannot schedule 1-week follow-up for", order.orderId);
    return;
  }
  if (oneWeekTimers[order.orderId]) {
    clearTimeout(oneWeekTimers[order.orderId]);
    delete oneWeekTimers[order.orderId];
  }

  const timePassed = Date.now() - order.bulkEmailsCompletedAt.getTime();
  const timeLeft = ONE_WEEK - timePassed;
  if (timeLeft <= 0) {
    // 이미 1주일 이상 지났다면 즉시 발송
    sendOneWeekEmail(order);
    return;
  }
  oneWeekTimers[order.orderId] = setTimeout(() => {
    sendOneWeekEmail(order);
  }, timeLeft);

  console.log(`⏰ Scheduled 1-week follow-up email for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
}

function scheduleTwoWeekFollowUpEmail(order) {
  // 이미 보냈거나 bulkEmailsCompletedAt 없으면 skip
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
    // 이미 2주 이상 지났다면 즉시 발송
    sendTwoWeekEmail(order);
    return;
  }
  twoWeekTimers[order.orderId] = setTimeout(() => {
    sendTwoWeekEmail(order);
  }, timeLeft);

  console.log(`⏰ Scheduled 2-week follow-up email for #${order.orderId} in ${Math.round(timeLeft / 1000 / 60)} minutes`);
}

async function sendOneWeekEmail(order) {
  const followUpHtml = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height:1.6;">
        <h2 style="margin-bottom: 0;">It's Been a Week! How's It Going?</h2>
        <p style="margin-top: 5px;">Hello from Smart Talent Matcher,</p>
        <p>
          It's been a week since we sent out your introduction. Usually, replies from talent agents,
          casting directors, and managers come steadily within the first two weeks, though some may trickle in later.
          Don’t lose hope even if you haven't received as many responses as you'd like!
        </p>
        <p>
          If you do get good news, please make sure to read the contract thoroughly before signing.
          People often get swept up in excitement and sign without fully understanding the agreement,
          which can lead to difficulties later. If the contract is too complex, feel free to ask ChatGPT for help
          in simplifying the language.
        </p>
        <p>
          Keep in mind that different agents may use different platforms. Verify which platform they use,
          and note that access levels can differ by region even on the same platform.
          The more access they have, the more opportunities they can bring you.
        </p>
        <p>
          Also, managers can vary widely in how they handle 'career management.' Make sure you clarify
          their scope of support since it can sometimes be quite broad or ambiguous.
        </p>
        <p>
          Finally, expect another follow-up email in the second week—so stay tuned!
        </p>
        <br>
        
        <p>Best Regards,<br>Smart Talent Matcher Team</p>
      </body>
    </html>
  `;
  const mailDataFollowUp = {
    subject: "[Smart Talent Matcher] One-Week Follow-Up",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: followUpHtml,
    isTransactional: true,
  };
  try {
    console.log(">>> [DEBUG] Sending 1-week follow-up email to:", order.emailAddress);
    await sendEmailAPI(mailDataFollowUp);

    // DB 업데이트
    order.oneWeekFollowUpSent = true;
    await order.save();

    console.log("✅ [DEBUG] 1-week follow-up email sent & order updated.");

    // 1주차 메일 보낸 뒤, 2주차 스케줄 설정
    scheduleTwoWeekFollowUpEmail(order);

  } catch (err) {
    console.error("❌ [DEBUG] Error sending 1-week follow-up email:", err);
  }
}

async function sendTwoWeekEmail(order) {
  // 2주차 메일 템플릿
  const twoWeekHtml = `
  <html>
    <body style="font-family: Arial, sans-serif; background-color:#f9f9f9; color:#333; line-height:1.6;">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; background-color:#f9f9f9; color: #333;">
        <tr>
          <td align="center" style="padding: 30px;">
            <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff; border-radius:8px; padding:20px;">
              <tr>
                <td align="center" style="padding: 20px;">
                  <h2 style="color:#d9534f; margin-top:0;">
                    It's Been 2 Weeks. How Are You Doing?
                  </h2>
                  <br>
                  <p style="margin:0 0 15px 0;">
                    Hello from Smart Talent Matcher,
                  </p>
                  <br>
                  <p style="margin:0 0 15px 0;">
                    By now, you’ve reached the 2-week mark. Usually, most replies come in during these first two weeks,
                    though it’s possible to still receive occasional responses afterward.
                  </p>
                  <p style="margin:0 0 15px 0;">
                    If things are going well and you’re about to sign a contract, make sure you’ve carefully reviewed 
                    all the terms. We hope you connect with the right person for your career!
                  </p>
                  <p style="margin:0 0 15px 0;">
                    If it’s not going so well, please don’t be discouraged. You can always update your materials 
                    and try again. (I personally tried 2 times before success!)
                  </p>
                  <p style="margin:0 0 15px 0;">
                    Here’s a special promo code for your return: 
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
                    RETURN10
                  </div>
                  <p style="margin:0 0 15px 0;">
                    Apply this when you create a new order.
                  </p>
                  <p style="margin:0 0 15px 0;">
                    We’d also love to hear your feedback! Whether you succeeded or faced challenges, 
                    your thoughts on our service help us improve. 
                  </p>
                  <br>
                  <a 
                    href="smarttalentmatcher.com/review.html" 
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
                    REVIEW
                  </a>
                  <br><br>
             <p style="margin:0 0 15px 0;">
          Thank you for trusting our service. We are committed to helping you find the right people.
        </p>
                  <p style="margin:30px 0 0 0;">
                    Best Regards,<br>
                    Smart Talent Matcher Team
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;

  const mailDataFollowUp = {
    subject: "[Smart Talent Matcher] Two-Week Follow-Up",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: twoWeekHtml,
    isTransactional: true,
  };
  try {
    console.log(">>> [DEBUG] Sending 2-week follow-up email to:", order.emailAddress);
    await sendEmailAPI(mailDataFollowUp);

    // 보냈다면 DB 업데이트
    order.twoWeekFollowUpSent = true;
    await order.save();

    console.log("✅ [DEBUG] 2-week follow-up email sent & order updated.");
  } catch (err) {
    console.error("❌ [DEBUG] Error sending 2-week follow-up email:", err);
  }
}

// ───────── [서버 시작 시, 미결제 final 주문 & 1주/2주 팔로업 복원] ─────────
async function restoreTimers() {
  try {
    // 1) (기존) 미결제 final 주문: 12h, 24h, 48h
    const pendingOrders = await Order.find({ status: "final", paid: false });
    console.log(`>>> [DEBUG] restoreTimers: found ${pendingOrders.length} final/pending orders (unpaid).`);
    pendingOrders.forEach((order) => {
      if (!order.reminderSent) scheduleReminder(order);
      scheduleAutoCancel(order);
      scheduleAutoDelete(order);
    });

    // 2) 결제된 + bulkEmailsCompletedAt 설정 + 1주차 안 보낸
    const needOneWeek = await Order.find({
      status: "final",
      paid: true,
      bulkEmailsCompletedAt: { $ne: null },
      oneWeekFollowUpSent: false
    });
    needOneWeek.forEach((order) => {
      scheduleOneWeekFollowUpEmail(order);
    });

    // 3) 결제된 + bulkEmailsCompletedAt 설정 + 1주차는 보냈지만 2주차 안 보낸
    const needTwoWeek = await Order.find({
      status: "final",
      paid: true,
      bulkEmailsCompletedAt: { $ne: null },
      oneWeekFollowUpSent: true,
      twoWeekFollowUpSent: false
    });
    needTwoWeek.forEach((order) => {
      scheduleTwoWeekFollowUpEmail(order);
    });

    console.log(`✅ Timers restored. (unpaid final=${pendingOrders.length}, 1-week=${needOneWeek.length}, 2-week=${needTwoWeek.length})`);
  } catch (err) {
    console.error("❌ Error restoring timers:", err);
  }
}

// ───────── [미제출(불완전한) 주문 정리 함수] ─────────
async function cleanUpIncompleteOrders() {
  const cutoff = new Date(Date.now() - (24 * 60 * 60 * 1000));
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

// ───────── [DB와 Cloudinary 동기화 함수] ─────────
async function syncCloudinaryWithDB() {
  try {
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

    const result = await cloudinary.api.resources({
      type: "upload",
      prefix: "SmartTalentMatcher/headshots",
      max_results: 500
    });
    for (const resource of result.resources) {
      if (!dbHeadshots.includes(resource.public_id)) {
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

// ───────── [리뷰 관련 라우트] ─────────

// 1) 새 리뷰 제출 (review.html)
app.post("/review-submission", async (req, res) => {
  try {
    const { reviewText } = req.body;
    if (!reviewText || !reviewText.trim()) {
      return res.status(400).json({ success: false, message: "Review text cannot be empty." });
    }
    const newReview = new Review({ reviewText: reviewText.trim() });
    await newReview.save();
    console.log(">>> [DEBUG] New review saved:", newReview);
    return res.json({ success: true, message: "Review saved successfully!" });
  } catch (err) {
    console.error("❌ Error in /review-submission:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// 2) 리뷰 목록 조회 (reviewadmin.html)
app.get("/admin/reviews", async (req, res) => {
  try {
    const reviews = await Review.find().sort({ createdAt: -1 });
    return res.json({ success: true, reviews });
  } catch (err) {
    console.error("❌ Error in /admin/reviews:", err);
    return res.status(500).json({ success: false, message: "Failed to load reviews." });
  }
});

// 3) 리뷰 수정
app.post("/admin/edit-review", async (req, res) => {
  try {
    const { reviewId, newText } = req.body;
    if (!reviewId || !newText || !newText.trim()) {
      return res.status(400).json({ success: false, message: "Invalid data." });
    }
    const updated = await Review.findByIdAndUpdate(
      reviewId,
      { reviewText: newText.trim() },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }
    console.log(">>> [DEBUG] Review updated:", updated);
    return res.json({ success: true, message: "Review updated successfully." });
  } catch (err) {
    console.error("❌ Error in /admin/edit-review:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// 4) 리뷰 삭제
app.post("/admin/delete-review", async (req, res) => {
  try {
    const { reviewId } = req.body;
    if (!reviewId) {
      return res.status(400).json({ success: false, message: "No reviewId provided." });
    }
    const deleted = await Review.findByIdAndDelete(reviewId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Review not found or already deleted." });
    }
    console.log(">>> [DEBUG] Review deleted:", deleted);
    return res.json({ success: true, message: "Review deleted successfully." });
  } catch (err) {
    console.error("❌ Error in /admin/delete-review:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ───────── [라우트 설정: Orders 등] ─────────

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

// (주문 생성 라우트: Draft Order)
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

// (주문 수정 라우트: Draft Order 업데이트)
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

// (최종 제출: Draft -> Final)
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

// ───────── [parseSelectedNames 함수: 미리 정해진 6개 이름 중 매칭] ─────────
function parseSelectedNames(invoiceHtml) {
  if (!invoiceHtml) return [];

  // 1) 미리 정해진 6개 국가(지역) 이름
  const countryList = [
    "Africa",
    "Asia",
    "Australia",
    "South America",
    "United Kingdom (+EU)",
    "United States (+Canada)",
  ];

  // 2) 대소문자 구분 없이 검사하기 위해 invoiceHtml을 소문자로
  const lowerHtml = invoiceHtml.toLowerCase();

  // 3) countryList 각 항목이 invoiceHtml에 들어있는지 검사
  const selected = [];
  for (const country of countryList) {
    if (lowerHtml.includes(country.toLowerCase())) {
      selected.push(country);
    }
  }

  return selected;
}

// ───────── [대량 메일 전송(Chunk+Delay)] ─────────
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

    const promises = chunk.map(recipientEmail => {
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

// 전역 큐 선언: 초기에는 이미 resolved된 Promise로 시작
let bulkEmailQueue = Promise.resolve();

// ───────── [/admin/toggle-payment 라우트] ─────────
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

      // 1) 서비스 시작 이메일 발송
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
        isTransactional: true,
      };
      console.log(">>> [DEBUG] Sending service-start email to:", order.emailAddress);
      await sendEmailAPI(mailDataStart);
      console.log("✅ [DEBUG] Service start email sent.");

      // 2) bulk 이메일 작업을 전역 큐에 추가하여 순차 실행
      bulkEmailQueue = bulkEmailQueue.then(async () => {
        console.log(">>> [DEBUG] Starting Bulk Email Logic for order", order.orderId);

        // (A) invoice에서 지역 분석
        const selectedCountries = parseSelectedNames(order.invoice);
        console.log(">>> [DEBUG] selectedCountries =", selectedCountries);

        if (selectedCountries.length === 0) {
          console.log(">>> [DEBUG] No selected countries. Skipping bulk emailing.");
          return;
        }

        // (B) 해당 국가 이메일 목록 수집
        let allEmails = [];
        for (const country of selectedCountries) {
          const recipients = await BulkEmailRecipient.find({ countryOrSource: country });
          console.log(`>>> [DEBUG] found ${recipients.length} for countryOrSource="${country}"`);
          recipients.forEach(r => {
            if (r.email) {
              allEmails.push(r.email.trim().toLowerCase());
            }
          });
        }
        const uniqueEmails = [...new Set(allEmails)];
        console.log(">>> [DEBUG] uniqueEmails after dedup =", uniqueEmails.length);

        // (C) 메일 본문 구성
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

        // (D) 공통 Bulk Template
        const bulkMailDataTemplate = {
          subject: order.emailSubject || "[No Subject Provided]",
          from: process.env.ELASTIC_EMAIL_USER,
          fromName: "",
          bodyHtml: emailHtml,
          isTransactional: false,
          replyTo: order.emailAddress,
          replyToName: order.emailAddress
        };

        // (E) 실제 전송 (Chunk/Delay)
        console.log(">>> [DEBUG] Starting to send Bulk Emails in Chunks...");
        await sendBulkEmailsInChunks(uniqueEmails, bulkMailDataTemplate, 20, 1000);
        console.log("✅ [DEBUG] Bulk emailing completed for order", order.orderId);

        // (F) 모든 대량메일 발송 완료 시점 기록
        order.bulkEmailsCompletedAt = new Date();
        await order.save();

        // (G) All Emails Sent 안내메일
        const completedHtml = `
        <html>
          <body style="font-family: Arial, sans-serif; line-height:1.6;">
            <h2 style="margin-bottom: 0;">🎉🥳 All Emails Have Been Sent! 🥳🎉</h2>
            <p style="margin-top: 5px;">
              Dear Customer,
            </p>
            <p>
              We are thrilled to inform you that all bulk emails for your selected region(s)
              <strong>${selectedCountries.join(", ")}</strong>
              have been successfully delivered.
            </p>
            <p>
              Thank you for trusting our service. We are committed to helping you find the right people.
            </p>
            <br>
        
            <!-- What's Next? -->
            <table style="border-top:2px solid #cccccc; width:100%; max-width:600px; margin:0 auto; padding-top:20px;">
              <tr>
                <td align="center" style="padding:0 20px;">
                  <h3 style="margin-top:0; margin-bottom:15px; font-family:Arial, sans-serif; font-size:1.6rem; font-weight:bold; color:#000; line-height:1.3;">
                    What's Next?
                  </h3>
                  <p style="margin:0 0 10px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#555; line-height:1.5;">
                    &#10003; Now that your introduction has reached relevant talent agents, casting directors, and managers in
                    <strong>${selectedCountries.join(", ")}</strong>,
                    you can expect replies directly to your email.
                  </p>
                  <p style="margin:0 0 10px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#555; line-height:1.5;">
                    &#10003; Some may respond with rejections (e.g., roster is full, only working with locals, etc.). 
                    This is completely normal, so please don't be discouraged.
                  </p>
                  <p style="margin:0 0 10px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#FF0000; font-weight:bold; line-height:1.5;">
                    &#9888; A 10% discount for your extended targeting campaign is already reflected in your invoice.
                  </p>
                  <p style="margin:0 0 10px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#555; line-height:1.5;">
                    &#10003; Our responsibility at Smart Talent Matcher ends here, 
                    and any further steps or responses will be up to you.
                  </p>
                  <p style="margin:0 0 10px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#555; line-height:1.5;">
                    &#10003; You may be invited to phone calls or Zoom meetings. Please present yourself professionally 
                    to leave a great impression and seize the opportunity.
                  </p>
                  <p style="margin:0 0 20px 0; max-width:500px; text-align:left; font-family:Arial, sans-serif; font-size:14px; color:#555; line-height:1.5;">
                    &#10003; In about one week, we'll send another email packed with additional tips and insights 
                    based on our experience. Stay tuned!
                  </p>
                </td>
              </tr>
            </table>
        
            <p style="margin-top:20px;">
              Good luck with your next steps! We genuinely hope this campaign helps you connect with the right people and takes your career to new heights.
            </p>
        
            <p>Best Regards,<br>Smart Talent Matcher Team</p>
          </body>
        </html>
        `;
        const mailDataCompleted = {
          subject: `[Smart Talent Matcher] #${order.orderId} All Emails Sent!`,
          from: process.env.ELASTIC_EMAIL_USER,
          fromName: "Smart Talent Matcher",
          to: `${order.emailAddress}, info@smarttalentmatcher.com`,
          bodyHtml: completedHtml,
          isTransactional: true,
        };
        console.log(">>> [DEBUG] Sending final 'all sent' email to:", order.emailAddress);
        await sendEmailAPI(mailDataCompleted);
        console.log("✅ [DEBUG] Final confirmation email sent.");

        // (H) 1주 후 팔로업 메일 스케줄링
        scheduleOneWeekFollowUpEmail(order);
      });

      // 모든 bulk 이메일 작업 끝날 때까지 대기
      await bulkEmailQueue;

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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);

  // CSV 로드 및 타이머/정리작업 실행
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
      // CSV 로드 실패해도 나머지 루틴은 계속 진행
      restoreTimers();
      cleanUpIncompleteOrders();
      syncCloudinaryWithDB();
      cleanUpNonFinalOrders();
    });
});