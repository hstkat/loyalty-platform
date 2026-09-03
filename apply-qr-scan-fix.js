const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backoffice', 'transacties.html');
let content = fs.readFileSync(filePath, 'utf8');

const oldStr = `  async function selectLoyaltyCardByToken(token) {
    els.statusLine.textContent = 'Kaart controleren…';
    els.statusLine.classList.remove('error');
    try {
      const { orgId } = getConfig();
      const result = await apiGet('/organizations/' + orgId + '/loyalty-cards/pos/lookup/' + encodeURIComponent(token));
      if (!result.valid || !result.customerId) {
        els.statusLine.textContent = result.message || 'Deze kaart is niet geldig.';
        els.statusLine.classList.add('error');
        return;
      }
      // Rechtstreeks uit het lookup-antwoord vullen i.p.v. via de lokaal
      // ingeladen gastenlijst — die kan een zojuist geclaimde kaart nog
      // niet bevatten (voorkomt "onbekend pasje" bij een verse koppeling).
      els.customerHidden.value = result.customerId;
      els.selectedCustomerName.textContent = result.customerName || '(naam onbekend)';
      els.selectedCustomer.classList.add('show');
      els.customerSearch.value = '';
      els.autocompleteList.classList.remove('open');
      els.amountInput.focus();
      els.statusLine.textContent = 'Loyaltykaart herkend — vul het bedrag in.';
      els.statusLine.classList.remove('error');
    } catch (err) {
      els.statusLine.textContent = 'Onbekend pasje — deze kaart is niet gevonden.';
      els.statusLine.classList.add('error');
    }
  }`;

const newStr = `  function applyResolvedCustomer(customerId, customerName, statusMsg) {
    // Rechtstreeks uit het lookup-antwoord vullen i.p.v. via de lokaal
    // ingeladen gastenlijst — die kan een zojuist geclaimde kaart/gast nog
    // niet bevatten (voorkomt "onbekend pasje" bij een verse koppeling).
    els.customerHidden.value = customerId;
    els.selectedCustomerName.textContent = customerName || '(naam onbekend)';
    els.selectedCustomer.classList.add('show');
    els.customerSearch.value = '';
    els.autocompleteList.classList.remove('open');
    els.amountInput.focus();
    els.statusLine.textContent = statusMsg;
    els.statusLine.classList.remove('error');
  }

  async function selectLoyaltyCardByToken(token) {
    els.statusLine.textContent = 'Kaart controleren…';
    els.statusLine.classList.remove('error');
    const { orgId } = getConfig();

    // Portal-QR (de "Mijn Tegoed"-widget) is de belangrijkste scanflow
    // en heeft voorrang. Faalt dat (geen geldig/niet-verlopen portal-
    // token), dan pas terugvallen op de fysieke-loyaltykaart-lookup.
    try {
      const qrResult = await apiGet('/organizations/' + orgId + '/customers/qr-lookup/' + encodeURIComponent(token));
      applyResolvedCustomer(qrResult.customerId, qrResult.customerName, 'Portal-QR herkend — vul het bedrag in.');
      return;
    } catch {
      // Geen geldig portal-QR-token — val terug op fysieke loyaltykaart.
    }

    try {
      const result = await apiGet('/organizations/' + orgId + '/loyalty-cards/pos/lookup/' + encodeURIComponent(token));
      if (!result.valid || !result.customerId) {
        els.statusLine.textContent = result.message || 'Deze kaart is niet geldig.';
        els.statusLine.classList.add('error');
        return;
      }
      applyResolvedCustomer(result.customerId, result.customerName, 'Loyaltykaart herkend — vul het bedrag in.');
    } catch (err) {
      els.statusLine.textContent = 'Onbekend pasje — deze kaart is niet gevonden.';
      els.statusLine.classList.add('error');
    }
  }`;

if (!content.includes(oldStr)) {
  console.error('FOUT: de originele functie is niet exact gevonden — bestand is mogelijk al gewijzigd of afwijkend. Geen wijziging toegepast.');
  process.exit(1);
}

content = content.replace(oldStr, newStr);
fs.writeFileSync(filePath, content, 'utf8');
console.log('Gelukt: scanfunctie in backoffice/transacties.html bijgewerkt (portal-QR heeft nu voorrang).');