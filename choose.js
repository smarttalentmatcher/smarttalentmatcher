/* choose.js */

// DOM 요소 선택
const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedItemsDiv = document.getElementById("selected-items");

const subtotalEl = document.getElementById("subtotal");
const baseDiscountEl = document.getElementById("base-discount");
const promoDiscountLine = document.getElementById("promo-discount-line");
const promoDiscountLabel = document.getElementById("promo-discount-label");
const promoDiscountEl = document.getElementById("promo-discount");
const finalCostEl = document.getElementById("final-cost");

// 기본 할인율 (10%)
const BASE_DISCOUNT_RATE = 0.1;

// 프로모션 관련 변수
let promoRate = 0.0;

// 체크박스 변경 시 비용 업데이트
checkboxes.forEach(cb => cb.addEventListener("change", updateCost));
window.addEventListener("load", updateCost);

// 프로모션 코드 적용
document.getElementById("apply-promo-btn").addEventListener("click", applyPromo);

function applyPromo() {
  const promoInput = document.getElementById("promo-code");
  const promoMessage = document.getElementById("promo-message");
  const code = promoInput.value.trim().toUpperCase();

  // 초기화
  promoMessage.textContent = "";
  promoRate = 0.0;

  // 프로모션 코드 적용
  if (code === "WELCOME10") {
    promoRate = 0.1;
    promoMessage.textContent = "WELCOME10 applied: -10% discount!";
  } else if (code === "RETURN15") {
    promoRate = 0.15;
    promoMessage.textContent = "RETURN15 applied: -15% discount!";
  } else if (code !== "") {
    promoMessage.textContent = "Invalid promo code.";
  }

  updateCost();
}

// 비용 및 영수증 업데이트
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = "";

  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      sum += cost;
    }
  });

  // 기본 할인 적용
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;

  // 프로모션 할인 적용
  const promoDiscountAmount = discountedAfterBase * promoRate;
  let finalAfterPromo = discountedAfterBase - promoDiscountAmount;

  if (finalAfterPromo < 0) finalAfterPromo = 0;

  // UI 업데이트
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  if (promoRate > 0) {
    promoDiscountLine.style.display = "block";
    promoDiscountLabel.textContent = `Promo Discount: -${(promoRate * 100).toFixed(0)}%`;
    promoDiscountEl.textContent = `-$${promoDiscountAmount.toFixed(2)}`;
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = finalAfterPromo.toFixed(2);
}

// Next 버튼 클릭 시 서버 전송
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  const subtotal = parseFloat(subtotalEl.textContent || "0");
  const baseDiscount = parseFloat(baseDiscountEl.textContent || "0");
  const finalCost = parseFloat(finalCostEl.textContent || "0");
  const promoDiscountText = promoDiscountLabel.textContent;

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
        <span class="receipt-desc">Discount: -10%:</span>
        <span class="receipt-price">-$${baseDiscount.toFixed(2)}</span>
      </div>
      ${promoRate > 0 ? `
        <div class="receipt-line">
          <span class="receipt-desc">${promoDiscountText}:</span>
          <span class="receipt-price">${promoDiscountEl.textContent}</span>
        </div>
      ` : ""}
      <hr>
      <div class="receipt-line" style="font-weight:bold;">
        <span class="receipt-desc">Final Cost:</span>
        <span class="receipt-price">$${finalCost.toFixed(2)}</span>
      </div>
    </div>
  `;

  fetch("/submit-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoice: invoiceHTML, finalCost })
  }).then(response => response.json()).then(result => {
    console.log("Order submitted:", result);
    window.location.href = "/resume.html";
  }).catch(err => console.error("Error submitting order:", err));
});