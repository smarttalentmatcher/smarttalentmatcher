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
      // 서비스 시작 안내 이메일 내용 (send-test-email과 동일한 형식)
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

      // 안내 이메일은 letsspeak01@naver.com 에서 발송
      await transporter.sendMail({
        from: `"Smart Talent Matcher" <letsspeak01@naver.com>`,
        to: order.emailAddress,
        subject: "[Smart Talent Matcher] Your Service Has Started!",
        html: emailHtml
      });
      console.log(`📩 Service start email sent to ${order.emailAddress}`);

      // ★ Smartlead API를 통해 대량 이메일 캠페인 시작
      // 스마트리드 API KEY는 .env에 SMARTLEAD_API_KEY 변수로 저장되어 있음.
      // VS Code 프로젝트 폴더 내 'csv' 폴더에서 CSV 파일들을 읽어 캠페인에 사용합니다.
      const csvFolderPath = path.join(__dirname, "csv");
      let smartleadSuccess = true;
      try {
        // CSV 확장자 파일들만 필터링
        const csvFiles = fs.readdirSync(csvFolderPath).filter(file => file.endsWith(".csv"));
        if (csvFiles.length === 0) {
          console.warn("⚠️ No CSV files found in folder:", csvFolderPath);
        } else {
          // 'form-data' 모듈 사용 (npm install form-data)
          const FormData = require("form-data");
          for (const csvFile of csvFiles) {
            const csvFilePath = path.join(csvFolderPath, csvFile);
            const form = new FormData();
            form.append("apiKey", process.env.SMARTLEAD_API_KEY);
            form.append("orderId", order.orderId);
            // CSV 파일 스트림 첨부
            form.append("recipientCsv", fs.createReadStream(csvFilePath));
            // 이메일 제목과 본문 첨부 (send-test-email과 동일한 내용)
            form.append("emailSubject", "[Smart Talent Matcher] Your Service Has Started!");
            form.append("emailHtml", emailHtml);
            // 발신자 정보 (답장 받을 주소)
            form.append("fromEmail", "letsspeak01@naver.com");

            // Smartlead API 호출 (실제 엔드포인트에 맞게 URL 수정)
            const smartleadResponse = await fetch("https://api.smartlead.io/start-campaign", {
              method: "POST",
              headers: form.getHeaders(),
              body: form
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
    } // <-- if (order.paid) 블록 종료

    res.json({ 
      success: true, 
      message: "Payment status updated, service start email sent, and email campaign started if paid." 
    });
  } catch (err) {
    console.error("❌ Error updating payment, sending email, or starting campaign:", err);
    res.status(500).json({ success: false, message: "Database error, email sending failed, or email campaign failed." });
  }
});