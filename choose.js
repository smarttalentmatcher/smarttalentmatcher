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

  // WELCOME10 (10%) 또는 RETURN15 (15%) 적용
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

// 프로모션 버튼 이벤트 리스너 부착
document.getElementById("apply-promo-btn").addEventListener("click", applyPromo);

// 비용 및 영수증 업데이트 함수
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = ""; // 영수증 영역 초기화

  // 체크된 체크박스의 비용 합산 (disabled 여부와 상관없이 checked이면 포함)
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      const rateText = cb.dataset.rate || "";
      const row = cb.closest("tr");
      const itemLabel = row.querySelector("td").textContent.trim();

      // 그룹별 접두사 결정
      let prefix = "";
      if (row.querySelector("td.us-package")) {
        prefix = "[Base Package] ";
      } else {
        let prev = row.previousElementSibling;
        while (prev && !prev.classList.contains("group-header")) {
          prev = prev.previousElementSibling;
        }
        if (prev) {
          prefix = `[${prev.querySelector("td").textContent.trim()}] `;
        }
      }

      // 영수증 라인 생성
      const lineDiv = document.createElement("div");
      lineDiv.className = "receipt-line";

      const descSpan = document.createElement("span");
      descSpan.className = "receipt-desc";
      descSpan.textContent = prefix + itemLabel;

      const priceSpan = document.createElement("span");
      priceSpan.className = "receipt-price";
      priceSpan.textContent = `$${cost.toFixed(2)} ${rateText}`;

      lineDiv.appendChild(descSpan);
      lineDiv.appendChild(priceSpan);
      selectedItemsDiv.appendChild(lineDiv);

      sum += cost;
    }
  });

  // 기본 할인 및 프로모 할인 계산
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;
  const promoPercentDiscount = discountedAfterBase * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // 화면 상 비용 업데이트 (달러 금액 표시)
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  const totalPromo = promoPercentDiscount + promoFlat;
  if (totalPromo > 0) {
    promoDiscountLine.style.display = "flex";
    promoDiscountLabel.textContent = "Promo Discount:";
    // 화면 상에는 달러 금액(계산 결과)을 그대로 표시합니다.
    promoDiscountEl.textContent = totalPromo.toFixed(2);
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = finalAfterPercent.toFixed(2);
}

// Next 버튼 클릭 시 서버로 주문 데이터 전송 후 resume.html로 이동
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  const subtotal = parseFloat(subtotalEl.textContent || "0");
  const baseDiscount = parseFloat(baseDiscountEl.textContent || "0");
  const finalCost = parseFloat(finalCostEl.textContent || "0");

  // 인보이스(영수증) HTML 생성 – promo discount는 퍼센트 형태로 표시
  const invoiceHTML = `
    <div>
      <h3>Selected Packages:</h3>
      <div>${selectedItemsDiv.innerHTML}</div>
      <hr>
      <div class="receipt-line">
        <span class="receipt-desc">Subtotal:</span>
        <span class="receipt-price">$${subtotal.toFixed(2)}</span>
      </div>
      <div class="receipt-line">
        <span class="receipt-desc">Base Discount (10%):</span>
        <span class="receipt-price">-$${baseDiscount.toFixed(2)}</span>
      </div>
      ${
        promoRate > 0
          ? `<div class="receipt-line">
               <span class="receipt-desc">Promo Discount:</span>
               <span class="receipt-price">-${(promoRate * 100).toFixed(0)}%</span>
             </div>`
          : ""
      }
      <hr>
      <div class="receipt-line" style="font-weight:bold;">
        <span class="receipt-desc">Final Cost:</span>
        <span class="receipt-price">$${finalCost.toFixed(2)}</span>
      </div>
    </div>
  `;

  // 서버로 전송할 데이터 객체 구성
  const orderData = {
    invoice: invoiceHTML,
    subtotal: subtotal.toFixed(2),
    discount: (baseDiscount).toFixed(2), // 할인 금액은 별도로 서버에서 처리할 수 있음
    finalCost: finalCost.toFixed(2)
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