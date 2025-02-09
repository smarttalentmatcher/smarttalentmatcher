// choose.js (최종 예시)

const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedItemsDiv = document.getElementById("selected-items");

// 비용 & 할인 표시용 DOM 요소
const subtotalEl = document.getElementById("subtotal");
const baseDiscountEl = document.getElementById("base-discount");
const promoDiscountLine = document.getElementById("promo-discount-line");
const promoDiscountLabel = document.getElementById("promo-discount-label");
const promoDiscountEl = document.getElementById("promo-discount");
const finalCostEl = document.getElementById("final-cost");

// 기본 할인(“-10% for invalid...”)은 항상 적용
const BASE_DISCOUNT_RATE = 0.1;

// 프로모 할인 관련 변수
let promoRate = 0.0;  // 퍼센트 할인 (ex: 0.1 → 10%)
let promoFlat = 0.0;  // 고정($) 할인 (여기서는 미사용)

// 체크박스 변화, DOMContentLoaded 시 비용 업데이트
checkboxes.forEach(cb => {
  cb.addEventListener("change", updateCost);
});
window.addEventListener("load", updateCost);

// 프로모코드 적용
function applyPromo() {
  const promoInput = document.getElementById("promo-code");
  const promoMessage = document.getElementById("promo-message");
  const code = promoInput.value.trim().toUpperCase();

  // 초기화
  promoMessage.textContent = "";
  promoRate = 0.0;
  promoFlat = 0.0;

  // 예: “WELCOME10” = 10%, “RETURN15” = 15%, “ACTOR10” = 10%
  if (code === "WELCOME10") {
    promoRate = 0.1;
    promoMessage.textContent = "WELCOME10 applied: +10% discount!";
  } else if (code === "RETURN15") {
    promoRate = 0.15;
    promoMessage.textContent = "RETURN15 applied: +15% discount!";
  } else if (code !== "") {
    // code가 빈칸이 아니고 위 3개 중 아무것도 아닐 때 → invalid
    promoMessage.textContent = "Invalid promo code.";
  }

  updateCost();
}

// 비용 및 영수증 업데이트
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = "";

  // 체크된 체크박스 모두 합산
  // => disabled라도 checked면 포함 (Base Package)
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      const rateText = cb.dataset.rate || "";
      const row = cb.closest("tr");
      const itemLabel = row.querySelector("td").textContent.trim();

      // 그룹 헤더 확인
      let prefix = "";
      if (row.querySelector("td.us-package")) {
        prefix = "[Base Package] ";
      } else {
        let prev = row.previousElementSibling;
        while (prev && !prev.classList.contains("group-header")) {
          prev = prev.previousElementSibling;
        }
        if (prev) {
          prefix = "[" + prev.querySelector("td").textContent.trim() + "] ";
        }
      }

      // 영수증 한 줄
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

  // 기본 10% 할인
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;

  // 프로모 (퍼센트) 할인
  const promoPercentDiscount = discountedAfterBase * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // 표시
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  // 프로모 total
  const totalPromo = promoPercentDiscount; // + promoFlat(0) if needed
  if (totalPromo > 0) {
    promoDiscountLine.style.display = "flex";
    promoDiscountLabel.textContent = "Promo Discount:";
    promoDiscountEl.textContent = totalPromo.toFixed(2);
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = finalAfterPercent.toFixed(2);
}

// Next 버튼
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  // 체크된 항목
  let selectedPackages = [];
  checkboxes.forEach(cb => {
    if (cb.checked) {
      selectedPackages.push({
        label: cb.dataset.label || "",
        cost: parseFloat(cb.dataset.cost || "0"),
        rate: cb.dataset.rate || ""
      });
    }
  });

  // 비용
  const subtotal = parseFloat(subtotalEl.textContent || "0");
  const baseDiscount = parseFloat(baseDiscountEl.textContent || "0");
  const finalCost = parseFloat(finalCostEl.textContent || "0");
  const promoDiscountVal = promoDiscountEl.textContent || "0"; // 프로모 할인액

  // 영수증 HTML
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
               <span class="receipt-price">-$${parseFloat(promoDiscountVal).toFixed(2)}</span>
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

  // 서버로 전송
  const data = {
    invoice: invoiceHTML,
    subtotal: subtotal.toFixed(2),
    discount: (baseDiscount + parseFloat(promoDiscountVal)).toFixed(2),
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