// choose.js

// 모든 체크박스와 영수증 표시 영역
const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedItemsDiv = document.getElementById("selected-items");

// 비용 & 할인 표시용 DOM
const subtotalEl = document.getElementById("subtotal");
const baseDiscountEl = document.getElementById("base-discount");
const promoDiscountLine = document.getElementById("promo-discount-line");
const promoDiscountLabel = document.getElementById("promo-discount-label");
const promoDiscountEl = document.getElementById("promo-discount");
const finalCostEl = document.getElementById("final-cost");

// 기본 할인(“-10% for invalid...”)은 항상 적용
const BASE_DISCOUNT_RATE = 0.1;

// 프로모 할인 관련 변수
let promoRate = 0.0;  // 퍼센트(%) 할인 (ex: 0.1 → 10%)
let promoFlat = 0.0;  // 고정($) 할인은 사용 안 함 (0)

// 체크박스 & 초기 로드 시 비용 업데이트
checkboxes.forEach(cb => {
  cb.addEventListener("change", updateCost);
});
window.addEventListener("load", updateCost);

// 프로모 코드 적용 함수
function applyPromo() {
  const promoInput = document.getElementById("promo-code");
  const promoMessage = document.getElementById("promo-message");
  const code = promoInput.value.trim().toUpperCase();

  // 초기화
  promoMessage.textContent = "";
  promoRate = 0.0;
  promoFlat = 0.0; // 여기서는 사용 X

  // 예: WELCOME10(10%), RETURN15(15%)
  if (code === "WELCOME10") {
    promoRate = 0.1;
    promoMessage.textContent = "WELCOME10 applied: +10% discount!";
  } else if (code === "RETURN15") {
    promoRate = 0.15;
    promoMessage.textContent = "RETURN15 applied: +15% discount!";
  } else if (code !== "") {
    // code가 빈칸이 아니고 위 두 가지도 아닐 때
    promoMessage.textContent = "Invalid promo code.";
  }

  updateCost();
}

// 비용 & 영수증 업데이트
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = ""; // 영수증 표시 영역 초기화

  // 체크된 체크박스 모두 합산 (disabled라도 checked면 포함)
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      const rateText = cb.dataset.rate || "";
      const row = cb.closest("tr");
      const itemLabel = row.querySelector("td").textContent.trim();

      // 그룹 헤더(예: "[Base Package]", "[For English Speakers]" 등)
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

      // 영수증 라인 생성 → selectedItemsDiv에 추가
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

  // 기본 할인(10%)
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;

  // 프로모 할인(퍼센트)
  const promoPercentDiscount = discountedAfterBase * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // UI 표시
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  // 프로모 할인액 (promoRate만 사용 중)
  const totalPromo = promoPercentDiscount + promoFlat; // promoFlat=0
  if (totalPromo > 0) {
    promoDiscountLine.style.display = "flex";
    promoDiscountLabel.textContent = "Promo Discount:";
    promoDiscountEl.textContent = totalPromo.toFixed(2);
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = finalAfterPercent.toFixed(2);
}

// Next 버튼 → 서버로 draft 주문 전송
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  // 비용 UI
  const subtotal = parseFloat(subtotalEl.textContent || "0");
  const baseDiscount = parseFloat(baseDiscountEl.textContent || "0");
  const finalCost = parseFloat(finalCostEl.textContent || "0");
  const promoDiscountVal = parseFloat(promoDiscountEl.textContent || "0"); // 프로모 할인액

  // 영수증 HTML (추가 라인 표시)
  // #selected-items 내부의 line들을 그대로 가져옴
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
        (promoDiscountLine.style.display === "flex")
          ? `<div class="receipt-line">
               <span class="receipt-desc">Promo Discount:</span>
               <span class="receipt-price">-$${promoDiscountVal.toFixed(2)}</span>
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

  // 서버에 전송할 데이터
  const data = {
    invoice: invoiceHTML,
    subtotal: subtotal.toFixed(2),
    discount: (baseDiscount + promoDiscountVal).toFixed(2),
    finalCost: finalCost.toFixed(2)
  };

  fetch(window.location.origin + "/submit-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  })
    .then(r => r.json())
    .then(res => {
      console.log("Order submitted:", res);
      if (res.success) {
        localStorage.setItem("orderId", res.orderId);
        // resume.html로 이동
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