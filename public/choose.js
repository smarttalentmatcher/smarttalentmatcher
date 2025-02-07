// 선택된 패키지(체크박스) 관련 요소들
const checkboxes = document.querySelectorAll(".package-checkbox");
const selectedItemsDiv = document.getElementById("selected-items");

// 비용 및 할인 관련 요소들
const subtotalEl = document.getElementById("subtotal");
const baseDiscountEl = document.getElementById("base-discount");
const promoDiscountLine = document.getElementById("promo-discount-line");
const promoDiscountLabel = document.getElementById("promo-discount-label");
const promoDiscountEl = document.getElementById("promo-discount");
const finalCostEl = document.getElementById("final-cost");

// 기본 할인 및 프로모 할인 설정
const BASE_DISCOUNT_RATE = 0.1; 
let PROMO_RATE = 0.0;

// 체크박스 상태가 변경될 때마다 비용 업데이트
checkboxes.forEach(cb => cb.addEventListener("change", updateCost));
document.addEventListener("DOMContentLoaded", updateCost);

// 프로모 코드 적용 함수
function applyPromo() {
  const promoInput = document.getElementById("promo-code");
  const promoMessage = document.getElementById("promo-message");
  const code = promoInput.value.trim().toUpperCase();

  PROMO_RATE = 0.0;
  promoMessage.textContent = "";

  if (code === "WELCOME10") {
    PROMO_RATE = 0.1;
    promoMessage.textContent = "WELCOME10 applied (+10% extra discount)";
  } else if (code === "RETURN15") {
    PROMO_RATE = 0.15;
    promoMessage.textContent = "RETURN15 applied (+15% extra discount)";
  } else if (code !== "") {
    promoMessage.textContent = "Invalid promo code.";
  }

  updateCost();
}

// 비용 및 영수증 업데이트 함수
function updateCost() {
  let sum = 0;
  selectedItemsDiv.innerHTML = "";

  checkboxes.forEach((checkbox) => {
    if (checkbox.checked) {
      const cost = parseFloat(checkbox.getAttribute("data-cost")) || 0;
      const rateText = checkbox.getAttribute("data-rate") || "";
      const row = checkbox.closest("tr");
      const itemLabel = row.querySelector("td").textContent.trim();

      // 그룹 헤더(예: [Base Package] 또는 [For English Speakers] 등) 확인
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

      // 영수증 한 줄 생성
      const lineDiv = document.createElement("div");
      lineDiv.className = "receipt-line";

      const descSpan = document.createElement("span");
      descSpan.className = "receipt-desc";
      descSpan.textContent = prefix + itemLabel;

      const priceSpan = document.createElement("span");
      priceSpan.className = "receipt-price";
      priceSpan.textContent = "$" + cost.toFixed(2) + " " + rateText;

      lineDiv.appendChild(descSpan);
      lineDiv.appendChild(priceSpan);
      selectedItemsDiv.appendChild(lineDiv);

      sum += cost;
    }
  });

  const baseDiscountAmount = sum * BASE_DISCOUNT_RATE;
  const promoDiscountAmount = sum * PROMO_RATE;
  const final = sum - (baseDiscountAmount + promoDiscountAmount);

  subtotalEl.textContent = sum.toFixed(2);
  baseDiscountEl.textContent = baseDiscountAmount.toFixed(2);

  if (PROMO_RATE > 0) {
    promoDiscountLine.style.display = "flex";
    const pRate = (PROMO_RATE * 100).toFixed(0);
    promoDiscountLabel.innerHTML = `Promo Discount: -${pRate}%`;
    promoDiscountEl.textContent = promoDiscountAmount.toFixed(2);
  } else {
    promoDiscountLine.style.display = "none";
  }

  finalCostEl.textContent = final.toFixed(2);
}

// Next 버튼 클릭 시 – 드래프트 주문을 서버로 전송 (invoice HTML 포함)
document.getElementById("next-button").addEventListener("click", (e) => {
  e.preventDefault();

  // 예시로 고정 이메일 (실제 서비스에서는 사용자가 입력한 값을 사용)
  const emailAddress = "no-email@example.com";

  // 영수증(Invoice) HTML 생성: .cost-summary 영역의 outerHTML을 그대로 가져옴
  const costSummaryElem = document.querySelector(".cost-summary");
  if (!costSummaryElem) {
    console.error("Cost summary element not found!");
    return;
  }
  const invoiceHTML = costSummaryElem.outerHTML;

  // 서버에 전송할 데이터 (invoice HTML 및 비용 관련 데이터 포함)
  const data = {
    emailAddress: emailAddress,
    invoice: invoiceHTML,
    subtotal: subtotalEl.textContent,
    discount: baseDiscountEl.textContent,
    finalCost: finalCostEl.textContent
  };

  fetch("/submit-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  })
    .then(r => r.json())
    .then(res => {
      console.log("Order submitted:", res);
      if (res.success) {
        // 서버가 발급한 orderId와 emailAddress를 localStorage에 저장 후 다음 단계(resume.html)로 이동
        localStorage.setItem("orderId", res.orderId);
        localStorage.setItem("emailAddress", emailAddress);
        window.location.href = "/resume.html";
      } else {
        alert("Order submission failed.");
      }
    })
    .catch(err => {
      console.error("Error submitting order:", err);
      alert("Order submission failed. Please try again.");
    });
});