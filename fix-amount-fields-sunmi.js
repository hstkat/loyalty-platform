const fs = require('fs');
const path = require('path');

function replaceOnce(content, label, oldStr, newStr, warnings) {
  if (!content.includes(oldStr)) {
    warnings.push(`  - "${label}" niet gevonden — overgeslagen`);
    return content;
  }
  return content.replace(oldStr, newStr);
}

// ============ gift-cards.html ============
(() => {
  const filePath = path.join(__dirname, 'backoffice', 'gift-cards.html');
  let content = fs.readFileSync(filePath, 'utf8');
  const warnings = [];

  content = replaceOnce(content, 'custom-amount-input veld',
    `<input type="number" id="custom-amount-input" placeholder="Bedrag in € (min. €10)" min="10" step="0.01">`,
    `<input type="text" inputmode="decimal" id="custom-amount-input" placeholder="Bedrag in € (min. €10)">`,
    warnings);

  content = replaceOnce(content, 'gc-redeem-amount-input veld',
    `<input type="number" id="gc-redeem-amount-input" placeholder="0,00" min="0.01" step="0.01" disabled>`,
    `<input type="text" inputmode="decimal" id="gc-redeem-amount-input" placeholder="0,00" disabled>`,
    warnings);

  content = replaceOnce(content, 'sanitizer-helper invoegen',
    `  const EMAIL_PATTERN = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\n\n`,
    `  const EMAIL_PATTERN = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

  // Bedragvelden zijn text+inputmode="decimal" i.p.v. type="number" — op
  // sommige ingebouwde Android-toetsenborden (o.a. kassaterminals als de
  // Sunmi) werkt het numerieke toetsenbord van type="number" niet
  // betrouwbaar. Deze sanitizer houdt de invoer alsnog netjes numeriek
  // en accepteert zowel komma als punt als decimaalteken.
  function sanitizeAmountInput(el) {
    let v = el.value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    if (v !== el.value) el.value = v;
  }
  els.customAmountInput.addEventListener('input', () => sanitizeAmountInput(els.customAmountInput));

`,
    warnings);

  content = replaceOnce(content, 'gcRedeemEls amount-listener uitbreiden',
    `  gcRedeemEls.amountInput.addEventListener('input', () => {
    const amount = parseFloat(gcRedeemEls.amountInput.value);
    gcRedeemEls.confirmBtn.disabled = !gcRedeemToken || !amount || amount <= 0 || amount > gcRedeemBalance;
  });`,
    `  gcRedeemEls.amountInput.addEventListener('input', () => {
    sanitizeAmountInput(gcRedeemEls.amountInput);
    const amount = parseFloat(gcRedeemEls.amountInput.value);
    gcRedeemEls.confirmBtn.disabled = !gcRedeemToken || !amount || amount <= 0 || amount > gcRedeemBalance;
  });`,
    warnings);

  fs.writeFileSync(filePath, content, 'utf8');
  if (warnings.length) {
    console.error('gift-cards.html — let op, niet alles is toegepast:');
    warnings.forEach((w) => console.error(w));
  } else {
    console.log('gift-cards.html: alle wijzigingen toegepast.');
  }
})();

// ============ transacties.html ============
(() => {
  const filePath = path.join(__dirname, 'backoffice', 'transacties.html');
  let content = fs.readFileSync(filePath, 'utf8');
  const warnings = [];

  content = replaceOnce(content, 'f-amount veld',
    `<input type="number" id="f-amount" step="0.01" min="0.01" required placeholder="0,00">`,
    `<input type="text" inputmode="decimal" id="f-amount" required placeholder="0,00">`,
    warnings);

  content = replaceOnce(content, 'gc-amount-input veld',
    `<input type="number" id="gc-amount-input" placeholder="Te besteden bedrag (€)" min="0.01" step="0.01" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--cream); font-family:'Inter',sans-serif; font-size:14px; margin-bottom:10px;" disabled>`,
    `<input type="text" inputmode="decimal" id="gc-amount-input" placeholder="Te besteden bedrag (€)" style="width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--cream); font-family:'Inter',sans-serif; font-size:14px; margin-bottom:10px;" disabled>`,
    warnings);

  content = replaceOnce(content, 'sanitizer-helper invoegen',
    `  function getConfig() {`,
    `  // Bedragvelden zijn text+inputmode="decimal" i.p.v. type="number" — op
  // sommige ingebouwde Android-toetsenborden (o.a. kassaterminals als de
  // Sunmi) werkt het numerieke toetsenbord van type="number" niet
  // betrouwbaar. Deze sanitizer houdt de invoer alsnog netjes numeriek
  // en accepteert zowel komma als punt als decimaalteken.
  function sanitizeAmountInput(el) {
    let v = el.value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    if (v !== el.value) el.value = v;
  }
  els.amountInput.addEventListener('input', () => sanitizeAmountInput(els.amountInput));

  function getConfig() {`,
    warnings);

  content = replaceOnce(content, 'gcEls amount-listener uitbreiden',
    `  gcEls.amountInput.addEventListener('input', () => {
    const amount = parseFloat(gcEls.amountInput.value);
    gcEls.confirmBtn.disabled = !gcLookedUpToken || !amount || amount <= 0 || amount > gcBalance;
  });`,
    `  gcEls.amountInput.addEventListener('input', () => {
    sanitizeAmountInput(gcEls.amountInput);
    const amount = parseFloat(gcEls.amountInput.value);
    gcEls.confirmBtn.disabled = !gcLookedUpToken || !amount || amount <= 0 || amount > gcBalance;
  });`,
    warnings);

  fs.writeFileSync(filePath, content, 'utf8');
  if (warnings.length) {
    console.error('transacties.html — let op, niet alles is toegepast:');
    warnings.forEach((w) => console.error(w));
  } else {
    console.log('transacties.html: alle wijzigingen toegepast.');
  }
})();