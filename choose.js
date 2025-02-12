/* choose.js */

// 모든 체크박스와 영수증 표시 영역 선택
const checkboxes = document.querySelectorAll(".package-checkbox");
// 새 HTML 구조에 맞춰 선택된 항목의 이름과 가격을 표시할 요소 선택
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

// 비용 및 영수증 업데이트 함수
function updateCost() {
  let sum = 0;
  let namesHTML = "";
  let costsHTML = "";

  // 체크된 체크박스의 비용 합산 (disabled 여부 상관없이 checked이면 포함)
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const cost = parseFloat(cb.dataset.cost || "0");
      const rateText = cb.dataset.rate || "";
      const row = cb.closest("tr");
      // 체크박스의 data-label 값을 사용
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

      // rateText에 대해 작고 회색 스타일 적용
      let rateHTML = "";
      if (rateText) {
        rateHTML = `<span style="font-size:0.85em; color:#666;">${rateText}</span>`;
      }

      // 여러 항목이면 줄바꿈 처리
      if (namesHTML !== "") {
        namesHTML += "<br>";
        costsHTML += "<br>";
      }
      namesHTML += prefix + label + " " + rateHTML;
      costsHTML += `$${cost.toFixed(2)}`; // 이미 $ 추가됨

      sum += cost;
    }
  });

  // 새 HTML 구조의 두 영역 업데이트
  selectedNamesDiv.innerHTML = namesHTML;
  selectedCostsDiv.innerHTML = costsHTML;

  // Subtotal 업데이트 
  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const discountedAfterBase = sum - baseDiscountAmount;

  // 프로모 할인 계산
  const promoPercentDiscount = sum * promoRate;
  let finalAfterPercent = discountedAfterBase - promoPercentDiscount;
  if (finalAfterPercent < 0) finalAfterPercent = 0;

  // (수정) subtotal에도 '$' 추가
  subtotalEl.textContent = `$${sum.toFixed(2)}`;

  // (수정) baseDiscount에도 '$' 추가
  baseDiscountEl.textContent = `$${baseDiscountAmount.toFixed(2)}`;

  if (promoPercentDiscount > 0) {
    promoDiscountLine.style.display = "flex"; 
    promoDiscountLabel.textContent = `Promo Discount: -${(promoRate * 100).toFixed(0)}%`;
    // (수정) promoDiscount에도 '$' 추가
    promoDiscountEl.textContent = `$${promoPercentDiscount.toFixed(2)}`;
  } else {
    promoDiscountLine.style.display = "none";
  }

  // (수정) finalCost에도 '$' 추가
  finalCostEl.textContent = `$${finalAfterPercent.toFixed(2)}`;
}

// Next 버튼 클릭 시 서버에 주문 데이터 전송 후 resume.html로 이동
document.getElementById("next-button").addEventListener("click", () => {
  console.log("Next 버튼 클릭됨");

  const subtotalVal = parseFloat(subtotalEl.textContent.replace("$", "") || "0");  // (수정) $ 제거 파싱
  const baseDiscountVal = parseFloat(baseDiscountEl.textContent.replace("$", "") || "0"); // (수정)
  const promoDiscountVal = parseFloat(promoDiscountEl.textContent.replace("$", "") || "0"); // (수정)
  const finalCostVal = parseFloat(finalCostEl.textContent.replace("$", "") || "0"); // (수정)

  // 인보이스(영수증) HTML을 현재 보여지는 디자인 그대로 저장
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