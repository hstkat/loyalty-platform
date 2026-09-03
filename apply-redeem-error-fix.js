const fs = require('fs');
const path = require('path');

function applyFix(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf8');
  let allOk = true;
  for (const { old, next, label } of replacements) {
    if (!content.includes(old)) {
      console.error(`FOUT in ${filePath}: "${label}" niet gevonden — bestand wijkt af, wijziging overgeslagen.`);
      allOk = false;
      continue;
    }
    content = content.replace(old, next);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return allOk;
}

// --- 1. Backend: foutmeldingen vertalen ---
const walletPath = path.join(__dirname, 'src', 'wallet', 'wallet.service.ts');
const walletOk = applyFix(walletPath, [
  {
    label: 'minimum redemption balance message',
    old: `throw new BadRequestException(\n        \`Minimum redemption balance not met: \${wallet.availableBalance} available, \${creditRule.minimumRedemptionBalance} required\`,\n      );`,
    next: `throw new BadRequestException(\n        \`Minimaal saldo voor inwisselen niet gehaald: \${wallet.availableBalance} pt beschikbaar, \${creditRule.minimumRedemptionBalance} pt nodig\`,\n      );`,
  },
  {
    label: 'insufficient redeemable balance message',
    old: `throw new BadRequestException(\n        \`Insufficient redeemable balance: available €\${totalAvailable.toFixed(2)}, requested €\${dto.amount.toFixed(2)}\`,\n      );`,
    next: `throw new BadRequestException(\n        \`Onvoldoende inwisselbaar tegoed: €\${totalAvailable.toFixed(2)} beschikbaar, €\${dto.amount.toFixed(2)} aangevraagd\`,\n      );`,
  },
  {
    label: 'reservation expired message',
    old: `throw new BadRequestException('Reservation has expired');`,
    next: `throw new BadRequestException('Reservering is verlopen — probeer opnieuw');`,
  },
]);

// --- 2. Frontend: foutmelding duidelijk zichtbaar maken ---
const htmlPath = path.join(__dirname, 'backoffice', 'transacties.html');
const htmlOk = applyFix(htmlPath, [
  {
    label: 'redeem-result CSS',
    old: `.redeem-result { margin-top: 14px; font-size: 13px; color: var(--teal-dark); min-height: 16px; }`,
    next: `.redeem-result { margin-top: 14px; font-size: 13px; color: var(--teal-dark); min-height: 16px; }
  .redeem-result.error {
    color: var(--coral); font-weight: 600; background: rgba(232, 96, 74, 0.08);
    border: 1px solid var(--coral-light); border-radius: 8px; padding: 10px 12px;
  }`,
  },
  {
    label: 'clear error class on transaction reset',
    old: `els.redeemQuoteDiv.textContent = '';\n      els.redeemResultDiv.textContent = '';\n      els.redeemConfirmBtn.disabled = true;`,
    next: `els.redeemQuoteDiv.textContent = '';\n      els.redeemResultDiv.textContent = '';\n      els.redeemResultDiv.classList.remove('error');\n      els.redeemConfirmBtn.disabled = true;`,
  },
  {
    label: 'clear error class on block redemption success',
    old: `els.redeemResultDiv.textContent = \`\${points(blockCount * blockSize)} afgeboekt (\${blockCount}x \${blockSize} pt) en bevestigd.\`;`,
    next: `els.redeemResultDiv.classList.remove('error');\n        els.redeemResultDiv.textContent = \`\${points(blockCount * blockSize)} afgeboekt (\${blockCount}x \${blockSize} pt) en bevestigd.\`;`,
  },
  {
    label: 'clear error class on catalog item redemption success',
    old: `els.redeemResultDiv.textContent = \`"\${item.name}" (\${item.pointsCost} pt) afgeboekt en bevestigd.\`;`,
    next: `els.redeemResultDiv.classList.remove('error');\n        els.redeemResultDiv.textContent = \`"\${item.name}" (\${item.pointsCost} pt) afgeboekt en bevestigd.\`;`,
  },
  {
    label: 'show prominent Dutch failure message',
    old: `els.redeemResultDiv.innerHTML = '<span class="warn">Inwisselen mislukt: ' + err.message + '</span>';\n      els.redeemConfirmBtn.disabled = false;`,
    next: `els.redeemResultDiv.classList.add('error');\n      els.redeemResultDiv.textContent = '⚠ Inwisselen mislukt — er is niets afgeboekt. ' + err.message;\n      els.redeemConfirmBtn.disabled = false;`,
  },
]);

if (walletOk && htmlOk) {
  console.log('Gelukt: foutmeldingen bij inwisselen zijn vertaald en duidelijk zichtbaar gemaakt.');
} else {
  console.error('Let op: niet alle wijzigingen zijn toegepast — zie foutmeldingen hierboven.');
  process.exit(1);
}