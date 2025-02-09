/* choose.js */

// 모든 체크박스와 영수증 표시 영역 선택
const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedItemsDiv = document.getElementById("selected-items");

// 비용 및 할인 관련 DOM 요소
const subtotalEl = document.getElementById("subtotal");
const baseDiscountEl = document.getElementById("base-discount");
const promoDiscountLine = document.getElementById("promo-discount-line");
const promoDiscountLabel = document.getElementById("promo-discount-label");
const promoDiscountEl = document.getElementById("promo-discount");
const finalCostEl = document.getElementById("final-cost");

// 기본 할인율 (10%)
const BASE_DISCOUNT_RATE = 0.1;

// 프로모 할인 관련 변수
let promoRate = 0.0;  // 예: 0.1 → 10%, 0.15 → 15%
let promoFlat = 0.0;  // 현재 사용하지 않음 (0)

// 체크박스 변경 시 비용 업데이트
checkboxes.forEach(cb => {
  cb.addEventListener("change", updateCost);
});
window.addEventListener("load", updateCost);

// 프로모션 코드 적용 함수
function applyPromo() {
  const promoInput = document.getElementById("promo-code");
  const promoMessage = document.getElementById("promo-message");
  const code = promoInput.value.trim().toUpperCase();

  // 초기화
  promoMessage.textContent = "";
  promoRate = 0.0;
  promoFlat = 0.0;

  // 예: WELCOME10 (10%), RETURN15 (15%)
  if (code === "WELCOME10") {
    promoRate = 0.1;
    promoMessage.textContent = "WELCOME10 applied: +10% discount!";
  } else if (code === "RETURN15") {
    promoRate = 0.15;
    promoMessage.textContent = "RETURN15 applied: +15% discount!";
  } else if (code !== "") {
    promoMessage.textContent = "Invalid promo code.";
  }
  updateCost();
}

// 프로모 버튼에 이벤트 리스너 부착
document.getElementById("apply-promo-btn").addEventListener("click", applyPromo);

// 비용 및 영수증 업데이트 함수
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = ""; // 영수증 영역 초기화

  // 체크된 체크박스 목록 순회
  checkboxes.forEach(cb => {
    if (cb.checked) {
      // 체크박스가 있는 행(tr)을 찾음
      const row = cb.closest("tr");

      // 5번째 열(예: row.children[4])의 Total 값 가져오기
      const totalCellText = row.children[4].textContent.trim().replace(/,/g, "");
      const totalEmails = parseInt(totalCellText, 10) || 0;

      // 0.005를 곱해서 비용 계산
      const cost = totalEmails * 0.005;

      // 국가/지역 이름(첫 번째 열)을 가져옴
      const itemLabel = row.querySelector("td").textContent.trim();

      // 그룹에 따른 접두사(prefix) 결정
      let prefix = "";
      if (row.querySelector("td.us-package")) {
        prefix = "[Base Package] ";
      } else {
        // 이전 형제가 group-header인지 체크
        let prev = row.previousElementSibling;
        while (prev && !prev.classList.contains("group-header")) {
          prev = prev.previousElementSibling;
        }
        if (prev) {
          prefix = `[${prev.querySelector("td").textContent.trim()}] `;
        }
      }

      // ─────────────────────────────────────────
      // 영수증 라인 생성 (Subtotal 같은 구조)
      // ─────────────────────────────────────────
      const lineDiv = document.createElement("div");
      lineDiv.className = "receipt-line"; // CSS 정렬용 클래스

      // 항목(왼쪽)
      const descSpan = document.createElement("span");
      descSpan.className = "receipt-desc";
      descSpan.textContent = prefix + itemLabel;

      // 가격(오른쪽)
      const priceSpan = document.createElement("span");
      priceSpan.className = "receipt-price";
      priceSpan.textContent = `$${cost.toFixed(2)} USD`;

      // lineDiv에 추가
      lineDiv.appendChild(descSpan);
      lineDiv.appendChild(priceSpan);
      selectedItemsDiv.appendChild(lineDiv);

      // 합계에 더하기
      sum += cost;
    }
  });

  // 기본 할인 및 프로모 할인 계산
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;
  const promoPercentDiscount = sum * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // 화면에 비용 업데이트
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  // 프로모션 할인 표시
  if (promoPercentDiscount > 0) {
    promoDiscountLine.style.display = "flex";
    promoDiscountLabel.textContent = `Promo Discount: -${(promoRate * 100).toFixed(0)}%`;
    promoDiscountEl.textContent = promoPercentDiscount.toFixed(2);
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = finalAfterPercent.toFixed(2);
}

// Next 버튼 → 서버에 인보이스 전송
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  const subtotalVal = parseFloat(subtotalEl.textContent || "0");
  const baseDiscountVal = parseFloat(baseDiscountEl.textContent || "0");
  const promoDiscountVal = parseFloat(promoDiscountEl.textContent || "0");
  const finalCostVal = parseFloat(finalCostEl.textContent || "0");

  // 지금 화면에 표시된 영수증 HTML(.cost-summary)을 그대로 가져오기
  const invoiceHTML = document.querySelector(".cost-summary").outerHTML;

  // 서버로 전송할 데이터
  const orderData = {
    invoice: invoiceHTML,  // 디자인 포함된 HTML 전송
    subtotal: subtotalVal.toFixed(2),
    baseDiscount: baseDiscountVal.toFixed(2),
    promoDiscount: promoDiscountVal.toFixed(2),
    finalCost: finalCostVal.toFixed(2)
  };

  fetch(window.location.origin + "/submit-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderData)
  })
    .then(response => response.json())
    .then(result => {
      console.log("Order submitted:", result);
      if (result.success) {
        localStorage.setItem("orderId", result.orderId);
        window.location.href = window.location.origin + "/resume.html";
      } else {
        alert("Order submission failed.");
      }
    })
    .catch(err => {
      console.error("Error submitting order:", err);
      alert("Order submission failed. Please try again.");
    });
});