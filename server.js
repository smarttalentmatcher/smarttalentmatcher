// --------------------------------------------------------------------------------
// SERVER.JS (ESM 버전) - 전체 코드 (Reply-To, parseSelectedNames for multiple countries)
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

// [중요 수정] 이메일 수신자 (BulkEmailRecipient) 스키마
// - 중복 허용을 위해 unique 제거
// - 지역명(countryOrSource) 필드 추가
const bulkEmailRecipientSchema = new mongoose.Schema({
  email: { type: String, required: true },
  countryOrSource: { type: String, default: "" }
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

// ───────── [Elastic Email 이용 메일발송 함수 - Reply-To 지원] ─────────
async function sendEmailAPI({
  subject,
  from,
  fromName,
  to,
  bodyHtml,
  isTransactional = true,
  replyTo,        // Reply-To 추가
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

  // Reply-To
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

      // .csv 확장자만 필터링
      const csvFiles = files.filter(file => file.toLowerCase().endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }

      console.log(`[CSV Import] Found ${csvFiles.length} CSV file(s):`, csvFiles);

      // 기존 BulkEmailRecipient 전체 삭제 후 새로 입력
      BulkEmailRecipient.deleteMany({})
        .then(() => {
          let filesProcessed = 0;

          csvFiles.forEach(file => {
            const filePath = path.join(csvFolderPath, file);
            // 파일명에서 ".csv" 제거 → 지역명 추출
            const regionName = path.basename(file, ".csv");

            let insertedCountThisFile = 0;

            fs.createReadStream(filePath)
              .pipe(csvParser({
                headers: ["email"], // 첫 번째 컬럼을 email
                skipLines: 1,       // CSV의 첫 번째 줄(헤더)을 건너뛰기
                bom: true
              }))
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

// ───────── [추가: DB와 Cloudinary 동기화 함수] ─────────
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

const cleanUpNonFinalOrders = async () => {
  // 필요시 구현
};

// ───────── [parseSelectedNames 함수: 다중 국가 파싱] ─────────
function parseSelectedNames(invoiceHtml) {
  if (!invoiceHtml) return [];

  // 1) <span id="selected-names">…</span> 추출
  const match = invoiceHtml.match(/<span[^>]*id=["']selected-names["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!match || !match[1]) return [];

  let text = match[1].trim();

  // 2) <br> 기준으로 분리
  const lines = text.split(/<br\s*\/?>/i);

  // 3) 각 줄에서 [Base Package], <span>…</span> 등 불필요한 것 제거
  const results = lines.map(line => {
    line = line.replace(/\[.*?\]/g, "").trim();
    line = line.replace(/<span[^>]*>.*?<\/span>/g, "").trim();
    return line;
  });

  // 4) 공백 제거 후 남은 값만
  return results.filter(x => x);
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

// ───────── [/admin/toggle-payment] ─────────
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

    // 결제가 false->true 로 바뀌었을 때
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
        fromName: "Smart Talent Matcher",    // 바꿀 경우 ""로
        to: order.emailAddress,
        bodyHtml: startedHtml,
        isTransactional: true,

      };

      console.log(">>> [DEBUG] Sending service-start email to:", order.emailAddress);
      await sendEmailAPI(mailDataStart);
      console.log("✅ [DEBUG] Service start email sent.");

      // (B) 대량 메일 로직
      console.log(">>> [DEBUG] Starting Bulk Email Logic...");

      // 다중 국가 추출
      const selectedCountries = parseSelectedNames(order.invoice);
      console.log(">>> [DEBUG] selectedCountries =", selectedCountries);

      if (selectedCountries.length === 0) {
        console.log(">>> [DEBUG] No selected countries. Skipping bulk emailing.");
      } else {
        let allEmails = [];
        // 각 국가별로 DB에서 조회 -> allEmails에 모으기
        for (const country of selectedCountries) {
          const recipients = await BulkEmailRecipient.find({ countryOrSource: country });
          console.log(`>>> [DEBUG] found ${recipients.length} for countryOrSource="${country}"`);

          recipients.forEach(r => {
            if (r.email) {
              allEmails.push(r.email.trim().toLowerCase());
            }
          });
        }

        // 중복 제거
        const uniqueEmails = [...new Set(allEmails)];
        console.log(">>> [DEBUG] uniqueEmails after dedup =", uniqueEmails.length);

        // 템플릿 준비
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
          fromName: "",   // 보낸 사람 이름
          bodyHtml: emailHtml,
          isTransactional: false,

          replyTo: order.emailAddress,
          replyToName: order.emailAddress
        };

        console.log(">>> [DEBUG] Starting to send Bulk Emails in Chunks...");
        await sendBulkEmailsInChunks(uniqueEmails, bulkMailDataTemplate, 20, 1000);
        console.log("✅ [DEBUG] Bulk emailing completed!");
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