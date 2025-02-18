// --------------------------------------------------------------------------------
// SERVER.JS
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

// __filename, __dirname
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

  // 대량 메일 완료 시점 & 2주 팔로업 여부
  bulkEmailsCompletedAt: { type: Date, default: null },
  twoWeekFollowUpSent: { type: Boolean, default: false }
});
const Order = mongoose.model("Order", orderSchema);

// ───────── [Review 스키마 정의] ─────────
const reviewSchema = new mongoose.Schema({
  reviewText: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const Review = mongoose.model("Review", reviewSchema);

// +++ [CHANGED] 여기서부터: BulkEmailRecipient 스키마 관련 부분 삭제 +++
//
//   기존에는 CSV를 DB에 저장하기 위해 BulkEmailRecipient라는 스키마를 만들어
//   업로드 후 조회했으나, 이제는 로컬 CSV 파일에서 직접 읽어올 것이므로
//   BulkEmailRecipient 관련 정의 및 사용 코드를 제거했습니다.
//
//   (아래 주석 처리 예시)
// 
// ----------------------------------------------------------------------
// // ───────── [BulkEmailRecipient 스키마 정의] ─────────
// const bulkEmailRecipientSchema = new mongoose.Schema({
//   email: { type: String, required: true },
//   countryOrSource: { type: String, default: "" }
// });
// const BulkEmailRecipient = mongoose.model("BulkEmailRecipient", bulkEmailRecipientSchema);
// ----------------------------------------------------------------------
// +++ [CHANGED] 여기까지 +++

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

// ───────── [Elastic Email 메일발송 함수] ─────────
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

// +++ [CHANGED] 여기서부터: 로컬 CSV에서 이메일을 읽어오는 함수 추가 +++
//
//   /Users/kimsungah/Desktop/SmartTalentMatcher/csv/ 경로의
//   Africa.csv, Asia.csv, Australia.csv, South America.csv,
//   United Kingdom (+EU).csv, United States (+Canada).csv
//   파일에서 직접 이메일을 파싱하여 배열로 반환합니다.
//
//   아래 경로는 사용 환경에 맞게 수정할 수 있습니다.
//
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

async function getLocalEmailsForCountries(countries) {
  // CSV 파일 이름을 매핑하기 위한 객체
  const csvFileMap = {
    "Africa": "Africa.csv",
    "Asia": "Asia.csv",
    "Australia": "Australia.csv",
    "South America": "South America.csv",
    "United Kingdom (+EU)": "United Kingdom (+EU).csv",
    "United States (+Canada)": "United States (+Canada).csv"
  };

  let allEmails = [];

  for (const country of countries) {
    const fileName = csvFileMap[country];
    if (!fileName) {
      console.warn(`>>> [WARNING] No CSV file mapping found for country: ${country}`);
      continue;
    }

    // +++ [CHANGED] 절대경로 대신 __dirname을 이용한 상대경로로 수정 +++
    const filePath = path.join(__dirname, "csv", fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`>>> [WARNING] CSV file does not exist at: ${filePath}`);
      continue;
    }

    // 파일을 읽어와서 CSV 파싱
    const emails = await new Promise((resolve, reject) => {
      let results = [];
      fs.createReadStream(filePath)
        .pipe(csvParser({ headers: ["email"], skipLines: 1, bom: true }))
        .on("data", row => {
          if (row.email && row.email.trim() !== "") {
            results.push(row.email.trim().toLowerCase());
          }
        })
        .on("end", () => resolve(results))
        .on("error", err => reject(err));
    });

    allEmails = allEmails.concat(emails);
  }

  // 중복 제거 후 반환
  return [...new Set(allEmails)];
}

// +++ [CHANGED] 여기까지 +++

// ───────── [테스트 라우트] ─────────
app.get("/", (req, res) => {
  res.send("<h1>Hello from server.js - CSV Reload test</h1>");
});

// ───────── [타이머 관련 (테스트용 1/2/3분)] ─────────
// 실제값: 12h / 24h / 48h / 2주
// 여기서는 테스트 용도로 각각 1분 / 2분 / 3분 / 1분 설정
const TWELVE_HOURS = 12 * 60 * 60 * 1000;    // 실제 12시간 → 테스트 1분
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000; // 실제 24시간 → 테스트 2분
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000; // 실제 48시간 → 테스트 3분
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;       // 실제 2주 → 테스트 1분

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
        subject: "**Reminder** [Smart Talent Matcher] #${order.orderId} Invoice for Your Submission",
        from: process.env.ELASTIC_EMAIL_USER,
        fromName: "Smart Talent Matcher",
        to: savedOrder.emailAddress,
        bodyHtml: reminderEmailHtml,
        isTransactional: true
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

      const cancelHtml = 
`<table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; background-color:#f9f9f9; color: #333; line-height:1.6;">
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
</table>`;

      const mailData = {
        subject: "[Smart Talent Matcher] Invoice Auto-Canceled (24h) - Enjoy 10% Off with WELCOME10",
        from: process.env.ELASTIC_EMAIL_USER,
        fromName: "Smart Talent Matcher",
        to: order.emailAddress,
        bodyHtml: cancelHtml,
        isTransactional: true
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

  // Cloudinary 이미지 삭제
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
  const twoWeekHtml = 
`<table width="100%" border="0" cellspacing="0" cellpadding="0" style="font-family: Arial, sans-serif; background-color:#f9f9f9; color:#333; line-height:1.6;">
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
              We hope you've found <span style="color:royalblue; font-weight: bold;">the Right Person</span>.<br><br>
              💡 Check which <strong>platform</strong> they use and the <strong>regions</strong> they have access to for breakdown services.<br>
              💡 Verify whether the contract is <strong>Exclusive</strong> or <strong>Non-Exclusive</strong>.<br>
              💡 Always <strong>REVIEW</strong> any contracts before signing<br>
              (ask ChatGPT for help if needed)!<br><br><br>
              However, <strong>if not,</strong> <span style="color:royalblue; font-weight: bold;">Don't Be Discouraged!</span><br>
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
              We’d also love to hear your <span style="color:royalblue; font-weight: bold;">Feedback!</span><br>
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
</table>`;

  const mailDataFollowUp = {
    subject: "[Smart Talent Matcher] Two-Week Follow-Up",
    from: process.env.ELASTIC_EMAIL_USER,
    fromName: "Smart Talent Matcher",
    to: order.emailAddress,
    bodyHtml: twoWeekHtml,
    isTransactional: true
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

// 서버 시작 시 타이머 복원
async function restoreTimers() {
  try {
    const pendingOrders = await Order.find({ status: "final", paid: false });
    console.log(`>>> [DEBUG] restoreTimers: found ${pendingOrders.length} final/pending orders (unpaid).`);
    pendingOrders.forEach((order) => {
      if (!order.reminderSent) scheduleReminder(order);
      scheduleAutoCancel(order);
      scheduleAutoDelete(order);
    });

    const needTwoWeek = await Order.find({
      status: "final",
      paid: true,
      bulkEmailsCompletedAt: { $ne: null },
      twoWeekFollowUpSent: false
    });
    needTwoWeek.forEach((order) => {
      scheduleTwoWeekFollowUpEmail(order);
    });

    console.log(`✅ Timers restored. (unpaid final=${pendingOrders.length}, 2-week=${needTwoWeek.length})`);
  } catch (err) {
    console.error("❌ Error restoring timers:", err);
  }
}

// 미완성(draft) 24h 지나면 DB & Cloudinary 정리
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

// DB와 Cloudinary 동기화 (오펜드 이미지 제거)
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

// 필요시 추가 정리
const cleanUpNonFinalOrders = async () => {
  // 필요에 따라 구현
};

// ───────── [리뷰(Review) 관련 라우트] ─────────

// 1) 새 리뷰 제출
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

// 2) 리뷰 목록 조회
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

// ───────── [주문(Order) 관련 라우트] ─────────

// 기본 페이지
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "resume.html"));
});

// 테스트 이메일 전송 라우트
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

// 주문 생성: Draft
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

// 주문 수정 (Draft 상태)
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

// 최종 제출 (Draft -> Final)
app.post("/final-submit", multer().none(), async (req, res) => {
  try {
    console.log(">>> [final-submit] Step 0: Endpoint called");
    const { orderId, emailAddress, emailSubject, actingReel, resumeLink, introduction, invoice, venmoId } = req.body;
    console.log(">>> [final-submit] Step 1: Request body received:", req.body);

    // 1) 동일 이메일(미결제) final 주문 모두 삭제
    console.log(">>> [final-submit] Step 2: Checking for old final (unpaid) orders with same emailAddress");
    const oldFinals = await Order.find({ emailAddress, status: "final", paid: false });
    if (oldFinals.length > 0) {
      console.log(`Found ${oldFinals.length} old final orders for ${emailAddress}. Deleting them...`);
      for (const oldOrder of oldFinals) {
        console.log(`>>> Canceling old final order #${oldOrder.orderId}`);
        const cancelHtml = 
        `<div style="font-family: Arial, sans-serif;">
            <p>Hello,</p>
            <p>Your previous invoice (Order #${oldOrder.orderId}) has been <strong>canceled</strong> because a new order was submitted.</p>
            <p>Only the new invoice will remain valid. If you have any questions, please contact us.</p>
            <br>
            <p>Regards,<br>Smart Talent Matcher</p>
        </div>`;
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

        // 헤드샷 삭제
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

    // 2) Draft → Final
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

    // 3) 관리자에게 배우 자료 이메일
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
      subject: `#${draftOrder.orderId} ${emailSubject || "[No Subject Provided]"}`,
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: process.env.ELASTIC_EMAIL_USER,
      bodyHtml: adminEmailHtml,
      isTransactional: true,
      replyTo: draftOrder.emailAddress,    // 클라이언트의 이메일 주소로 답장 설정
      replyToName: draftOrder.emailAddress   // 클라이언트의 이메일 주소를 이름으로 설정 (원하는 경우 변경 가능)
    });
    console.log("✅ Admin email sent.");

    // 4) 클라이언트 인보이스 이메일
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
      subject: "[Smart Talent Matcher] #${order.orderId} Invoice for Your Submission",
      from: process.env.ELASTIC_EMAIL_USER,
      fromName: "Smart Talent Matcher",
      to: draftOrder.emailAddress,
      bodyHtml: clientEmailHtml,
      isTransactional: true
    });
    console.log("✅ Client Invoice email sent.");

    // 5) 12h/24h/48h 타이머
    console.log(">>> [final-submit] Step 7: Scheduling timers for reminder, auto-cancel, and auto-delete");
    scheduleReminder(draftOrder);
    scheduleAutoCancel(draftOrder);
    scheduleAutoDelete(draftOrder);

    // 아직 미결제이므로 대량 메일/2주 팔로업은 여기서 안 함 (결제 후 진행)
    console.log(">>> [final-submit] Step 8: Returning success response");
    return res.json({
      success: true,
      message: "Final submission complete! Admin/client emails sent, timers scheduled (no bulk mail yet).",
      order: draftOrder
    });
  } catch (error) {
    console.error("❌ Error in final submission:", error);
    return res.status(500).json({ success: false, error: "Failed to process final submission." });
  }
});

// 관리자: 주문 목록 조회
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

// 관리자: 주문 삭제
app.post("/admin/delete-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    // Cloudinary 삭제
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

// 인보이스 내 국가명 파싱
function parseSelectedNames(invoiceHtml) {
  if (!invoiceHtml) return [];
  const countryList = [
    "Africa",
    "Asia",
    "Australia",
    "South America",
    "United Kingdom (+EU)",
    "United States (+Canada)",
  ];
  const lowerHtml = invoiceHtml.toLowerCase();
  const selected = [];
  for (const country of countryList) {
    if (lowerHtml.includes(country.toLowerCase())) {
      selected.push(country);
    }
  }
  return selected;
}

// 대량 메일(Chunk) 발송
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

// 전역 큐 (대량 메일 순차화)
let bulkEmailQueue = Promise.resolve();

// 결제 토글 → 결제(true) 후 대량 메일 & 2주 팔로업
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

    // 결제가 false → true 로 전환되면 대량 메일 로직 수행
    if (!oldPaid && order.paid) {
      console.log(">>> [DEBUG] Payment changed from false -> true. Will send 'service started' email AND then trigger bulk emailing.");

      // (A) "서비스 시작" 이메일
      const startedHtml = 
      `<html>
      <body style="font-family: Arial, sans-serif; line-height:1.6;">
        <h2>🎉 Your service has started! 🎉</h2>
        <p>Hello ${order.emailAddress ? order.emailAddress.split("@")[0] : ""},</p><br><br>
        <p>
          We are pleased to inform you that your payment has been successfully processed,
          and your service has now begun.
        </p>
         <p>
          Thank you for trusting our service. We are committed to helping you find the right people.
        </p><br>
        <p>
          Once all emails corresponding to your selected region have been sent,
          you will receive a confirmation email.
        </p><br><br>
        <p>Best Regards,<br>Smart Talent Matcher Team</p>
      </body>
      </html>`;
      const mailDataStart = {
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        from: process.env.ELASTIC_EMAIL_USER,
        fromName: "Smart Talent Matcher",
        to: order.emailAddress,
        bodyHtml: startedHtml,
        isTransactional: true
      };
      console.log(">>> [DEBUG] Sending service-start email to:", order.emailAddress);
      const serviceStartResult = await sendEmailAPI(mailDataStart);
      if (serviceStartResult && serviceStartResult.success) {
        console.log("✅ [DEBUG] Service start email sent.");
      }

      // (B) Bulk 이메일 발송 (순차 큐에 등록)
      bulkEmailQueue = bulkEmailQueue.then(async () => {
        console.log(">>> [DEBUG] Starting Bulk Email Logic for order", order.orderId);

        const selectedCountries = parseSelectedNames(order.invoice);
        console.log(">>> [DEBUG] selectedCountries =", selectedCountries);

        if (selectedCountries.length === 0) {
          console.log(">>> [DEBUG] No selected countries. Skipping bulk emailing.");
          return;
        }

        // +++ [CHANGED] 여기서부터: 로컬 CSV에서 메일 목록을 읽어오도록 변경 +++
        const uniqueEmails = await getLocalEmailsForCountries(selectedCountries);
        console.log(">>> [DEBUG] uniqueEmails after reading local CSV =", uniqueEmails.length);
        // +++ [CHANGED] 여기까지 +++

        const formattedIntro = order.introduction ? order.introduction.replace(/\r?\n/g, "<br>") : "";
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
          isTransactional: false,
          replyTo: order.emailAddress,
          replyToName: order.emailAddress
        };

        console.log(">>> [DEBUG] Sending Bulk Emails in Chunks...");
        await sendBulkEmailsInChunks(uniqueEmails, bulkMailDataTemplate, 20, 1000);
        console.log("✅ [DEBUG] Bulk emailing completed for order", order.orderId);

        order.bulkEmailsCompletedAt = new Date();
        await order.save();

        // (C) "All Emails Sent" 안내
        const completedHtml = 
`<html>
  <body style="font-family: Arial, sans-serif; line-height:1.6;">
    <h2 style="margin-bottom: 0;">🚀 All Emails Have Been Sent! 🚀</h2><br><br>
    <p>Dear Customer,</p><br><br>
    <p>
      We are thrilled to inform you that all bulk emails for your selected region(s)
      <br><strong>${selectedCountries.join(", ")}</strong> have been successfully delivered!
    </p><br>
    <p>
      Thank you for trusting our service. We are committed to helping you find the right people.
    </p><br>
    <p>
      ✅ Now that your introduction has reached Talent Agents, Casting Directors, and Managers in
      <strong>${selectedCountries.join(", ")}</strong>.
    </p>
    <p>
      ✅ Replies will be sent directly to the email you provided.
    </p>
    <p>
      ✅ Some may respond with rejections (e.g., roster is full, only working with locals, etc.). This is completely normal, so please don't be discouraged.
    </p>
    <p>
      ✅ A 10% discount For adjusting invalid or long-targeted emails is already reflected in your invoice.
    </p>
    <p>
      ✅ Please note that our responsibility at Smart Talent Matcher ends here.
    </p>
    <p>
      ✅ You may be invited to phone calls or Zoom meetings. Present yourself professionally to leave a great impression and seize the opportunity!
    </p>
    <p>
      ✅ You'll receive a 2-week follow-up email in two weeks! Stay tuned!
    </p><br><br>
    <p>
      Best Regards,<br>
      Smart Talent Matcher Team
    </p>
  </body>
</html>`;
        const mailDataCompleted = {
          subject: `[Smart Talent Matcher] #${order.orderId} All Emails Sent!`,
          from: process.env.ELASTIC_EMAIL_USER,
          fromName: "Smart Talent Matcher",
          to: `${order.emailAddress}, info@smarttalentmatcher.com`,
          bodyHtml: completedHtml,
          isTransactional: true
        };
        console.log(">>> [DEBUG] Sending final 'all sent' email to:", order.emailAddress);
        await sendEmailAPI(mailDataCompleted);
        console.log("✅ [DEBUG] Final confirmation email sent.");

        // (D) 2주 후 팔로업
        scheduleTwoWeekFollowUpEmail(order);
      });

      await bulkEmailQueue;
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error("❌ [DEBUG] Error in /admin/toggle-payment:", err);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});
//=== [Webhook 라우트 추가] ===
app.all("/webhook", (req, res) => {
  console.log(">>> [DEBUG] Received a webhook event...");
  return res.sendStatus(200);
});
// ───────── [서버 시작 및 초기 작업] ─────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  
  restoreTimers();
  cleanUpIncompleteOrders();
  syncCloudinaryWithDB();
  cleanUpNonFinalOrders();
  
});