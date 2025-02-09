/* choose.js */

// 모든 체크박스와 영수증 표시 영역 선택
const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedNamesDiv = document.getElementById("selected-names");
const selectedCostsDiv = document.getElementById("selected-costs");

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

function updateCost() {
  let sum = 0;
  // 새롭게 분리한 두 영역을 선택
  const selectedNamesSpan = document.getElementById("selected-names");
  const selectedCostsSpan = document.getElementById("selected-costs");

  // 기존 데이터 초기화
  selectedNamesSpan.innerHTML = "";
  selectedCostsSpan.innerHTML = "";

  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      const rateText = cb.dataset.rate || "";
      const row = cb.closest("tr");
      // 이제 itemLabel 대신 체크박스의 data-label을 사용합니다.
      const label = cb.dataset.label;

      // 그룹에 따른 접두사 결정
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

      // 선택된 항목의 이름 업데이트
      // 여러 항목이 있을 경우 줄바꿈 처리
      if (selectedNamesSpan.innerHTML !== "") {
        selectedNamesSpan.innerHTML += "<br>";
      }
      selectedNamesSpan.innerHTML += prefix + label + " " + rateText;

      // 총합 누적
      sum += cost;
    }
  });

  // 최종 금액을 selectedCostsSpan에 업데이트 (HTML에서 USD가 붙은 상태로 보입니다)
  selectedCostsSpan.textContent = sum.toFixed(2);
  // 또한, subtotal 영역도 업데이트 (이미 기존 코드에 있다면 그대로 유지)
  subtotalEl.textContent = sum.toFixed(2);
}

  // 기본 할인 및 프로모 할인 계산
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;
  const promoPercentDiscount = sum * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // 화면에 비용 업데이트
  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  const totalPromo = promoPercentDiscount + promoFlat;
  if (promoPercentDiscount > 0) {
    promoDiscountLine.style.display = "flex"; // 프로모 할인 라인 표시
    promoDiscountLabel.textContent = `Promo Discount: -${(promoRate * 100).toFixed(0)}%`; 
    promoDiscountEl.textContent = `${promoPercentDiscount.toFixed(2)}`; 
  } else {
    promoDiscountLine.style.display = "none"; // 프로모 할인 적용 안 되면 숨김
  }

  finalCostEl.textContent = finalAfterPercent.toFixed(2);
}

// Next 버튼 클릭 시 서버에 주문 데이터 전송 후 resume.html로 이동
document.getElementById("next-button").addEventListener("click", () => {
    console.log("Next 버튼 클릭됨");
  
    const subtotalVal = parseFloat(subtotalEl.textContent || "0");
    const baseDiscountVal = parseFloat(baseDiscountEl.textContent || "0");
    const promoDiscountVal = parseFloat(promoDiscountEl.textContent || "0");
    const finalCostVal = parseFloat(finalCostEl.textContent || "0");
  
    // ✅ 인보이스(영수증) HTML을 현재 보여지는 디자인 그대로 저장
    const invoiceHTML = document.querySelector(".cost-summary").outerHTML;
  
    // ✅ 서버로 전송할 데이터
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