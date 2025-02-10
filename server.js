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

//
// Express 앱 생성
//
const app = express();

// ✅ Render에서 자동으로 포트를 할당하도록 설정 (기본값 3000)
const PORT = process.env.PORT || 3000;

// 요청 로그 (디버깅용)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

/** 날짜 기반 오더ID 생성 */
function generateDateTimeOrderId() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return mm + dd + hh + min;
}

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

// ================================
// Start the server and perform cleanup on startup
// ================================
app.listen(PORT, () => {
  console.log(`✅ Server running at ${process.env.SERVER_URL || `http://localhost:${PORT}`}`);
  restoreTimers(); // 서버 재시작 시 기존 주문의 타이머 다시 설정
});