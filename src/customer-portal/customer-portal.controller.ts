import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

const DEFAULT_ORG_ID = 'ab51a93c-43a2-40cd-8635-f8522f68a8c8';
const API_BASE = 'https://loyalty-platform-live.vercel.app';

interface BrandConfig {
  slug: string;
  name: string;
  creditLabel: string;
  accent: string;
  accentDark: string;
}

const BRANDS: Record<string, BrandConfig> = {
  'het-strand': { slug: 'het-strand', name: 'Het Strand', creditLabel: 'Strand tegoed', accent: '#c47a45', accentDark: '#a1642f' },
  zomers: { slug: 'zomers', name: 'Zomers Beachclub & Brewery', creditLabel: 'Zomers tegoed', accent: '#497a9d', accentDark: '#376079' },
};
const DEFAULT_BRAND: BrandConfig = { slug: '', name: 'Mijn Tegoed', creditLabel: 'Tegoed', accent: '#e8604a', accentDark: '#c94d38' };

/**
 * Eén centrale portal-pagina, gebrand op basis van een query-parameter
 * — precies de gevraagde architectuur ("één centrale Customer Portal
 * met brand=... op basis van waarmee de gast binnenkomt") in plaats van
 * twee losse codebases. Het Strand en Zomers linken hier vanaf hun
 * eigen /mijn-tegoed-pagina naartoe (of laden 'm in een iframe) — zie
 * de integratie-instructies in het antwoord aan de gebruiker.
 *
 * Bewust GEEN zware PWA-opzet (geen manifest/service-worker) — dit is
 * primair een veilige, snelle mobiele webpagina, precies zoals gevraagd.
 */
@Controller('portal')
export class CustomerPortalController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  portalPage(@Query('brand') brandParam: string | undefined, @Query('org') orgParam: string | undefined, @Res() res: Response) {
    const brand = (brandParam && BRANDS[brandParam]) || DEFAULT_BRAND;
    const orgId = orgParam || DEFAULT_ORG_ID;
    res.status(200).send(this.renderPage(brand, orgId));
  }

  private renderPage(brand: BrandConfig, orgId: string): string {
    const styles = `
      :root {
        --cream: #f6f3ec; --white: #ffffff; --navy: #1b3a5c; --navy-dark: #0e1c2a;
        --body-text: #3a4a5c; --muted: #7a8ea0; --line: rgba(27,58,92,0.12);
        --accent: ${brand.accent}; --accent-dark: ${brand.accentDark};
      }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      body { margin: 0; background: var(--cream); color: var(--body-text); font-family: -apple-system, 'Inter', sans-serif; min-height: 100vh; }
      .wrap { max-width: 480px; margin: 0 auto; min-height: 100vh; background: var(--white); box-shadow: 0 0 40px rgba(27,58,92,0.06); }
      header { background: var(--navy-dark); padding: 20px 20px 16px; display: flex; justify-content: space-between; align-items: center; }
      header .brand-name { font-family: Georgia, serif; color: var(--white); font-size: 18px; }
      header button { background: none; border: 1px solid rgba(255,255,255,0.25); color: rgba(255,255,255,0.75); font-size: 12px; padding: 7px 14px; border-radius: 16px; cursor: pointer; }
      .accent-line { height: 3px; background: var(--accent); }
      main { padding: 20px; padding-bottom: 60px; }
      .screen { display: none; }
      .screen.active { display: block; }

      .login-card { text-align: center; padding: 30px 10px; }
      .login-card h1 { font-family: Georgia, serif; font-size: 24px; color: var(--navy); margin: 0 0 8px; }
      .login-card p { font-size: 14px; color: var(--muted); margin: 0 0 24px; line-height: 1.5; }
      input, textarea { width: 100%; padding: 13px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--cream); font-size: 15px; margin-bottom: 12px; font-family: inherit; color: var(--body-text); }
      .btn-primary { width: 100%; padding: 15px; border-radius: 10px; border: none; background: var(--accent); color: white; font-weight: 600; font-size: 15px; cursor: pointer; }
      .btn-primary:disabled { opacity: 0.55; }
      .btn-text { background: none; border: none; color: var(--muted); font-size: 13px; cursor: pointer; margin-top: 12px; text-decoration: underline; }
      .error-text { color: var(--accent-dark); font-size: 13px; margin-top: 8px; min-height: 16px; }
      .consent-row { display: flex; align-items: flex-start; gap: 8px; text-align: left; font-size: 13px; color: var(--muted); margin: 10px 0; }
      .consent-row input { width: auto; margin: 3px 0 0; }

      .card-box { background: var(--navy-dark); border-radius: 18px; padding: 26px 22px; text-align: center; color: white; margin-bottom: 16px; }
      .card-box .name { font-size: 26px; font-weight: 700; margin-bottom: 4px; }
      .card-box .credit-label { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.55); margin-bottom: 14px; }
      .card-box .big-balance { font-size: 44px; font-weight: 800; color: var(--accent); margin-bottom: 18px; line-height: 1; }
      .card-box .qr-wrap { background: white; border-radius: 12px; padding: 10px; display: inline-block; }
      .card-box .qr-wrap img { display: block; width: 190px; height: 190px; }
      .card-box .scan-hint { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 14px; }

      .balance-strip { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
      .balance-tile { background: var(--cream); border-radius: 12px; padding: 16px; text-align: center; }
      .balance-tile .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 6px; }
      .balance-tile .value { font-family: Georgia, serif; font-size: 24px; color: var(--navy); }
      .expiring-note { background: rgba(196,122,69,0.1); border: 1px solid var(--accent); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: var(--accent-dark); margin-bottom: 16px; }

      .section-title { font-family: Georgia, serif; font-size: 16px; color: var(--navy); margin: 22px 0 10px; }
      .list-item { background: var(--cream); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }
      .list-item .top-row { display: flex; justify-content: space-between; align-items: center; }
      .list-item .item-name { font-weight: 600; color: var(--navy); font-size: 14px; }
      .list-item .item-value { font-family: Georgia, serif; color: var(--accent-dark); font-size: 15px; }
      .list-item .item-meta { font-size: 11px; color: var(--muted); }
      .location-badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 8px; background: var(--line); color: var(--muted); margin-top: 5px; }
      .empty-note { font-size: 13px; color: var(--muted); text-align: center; padding: 16px; }

      .history-row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
      .history-row .amount.positive { color: #4a7a5e; font-weight: 600; }
      .history-row .amount.negative { color: var(--accent-dark); font-weight: 600; }

      nav.tabbar { position: sticky; bottom: 0; background: var(--white); border-top: 1px solid var(--line); display: flex; padding: 8px 4px; }
      nav.tabbar button { flex: 1; background: none; border: none; font-size: 10px; color: var(--muted); padding: 6px 2px; cursor: pointer; }
      nav.tabbar button.active { color: var(--accent-dark); font-weight: 600; }
    `;

    return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${brand.name} — Mijn Tegoed</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="brand-name">${brand.name}</span>
    <button id="logout-btn" style="display:none;">Uitloggen</button>
  </header>
  <div class="accent-line"></div>
  <main>

    <div class="screen active" id="screen-email">
      <div class="login-card">
        <h1>Mijn Tegoed</h1>
        <p>Bekijk je Beach Credit, punten, cadeaukaarten en meer.</p>
        <input type="email" id="email-input" placeholder="E-mailadres" autocomplete="email">
        <button class="btn-primary" id="request-code-btn">Verstuur code</button>
        <div class="error-text" id="email-error"></div>
      </div>
    </div>

    <div class="screen" id="screen-code">
      <div class="login-card">
        <h1>Check je inbox</h1>
        <p>We stuurden een 6-cijferige code naar je e-mailadres.</p>
        <input type="text" id="code-input" placeholder="000000" maxlength="6" inputmode="numeric">
        <button class="btn-primary" id="verify-code-btn">Inloggen</button>
        <button class="btn-text" id="back-to-email-btn">Ander e-mailadres</button>
        <div class="error-text" id="code-error"></div>
      </div>
    </div>

    <div class="screen" id="screen-register">
      <div class="login-card" style="text-align:left;">
        <h1 style="text-align:center;">Welkom!</h1>
        <p style="text-align:center;">Je e-mailadres is geverifieerd — nog een paar gegevens.</p>
        <input type="text" id="reg-firstname" placeholder="Voornaam">
        <input type="text" id="reg-lastname" placeholder="Achternaam (optioneel)">
        <input type="tel" id="reg-phone" placeholder="Telefoonnummer (optioneel)">
        <input type="date" id="reg-dob" placeholder="Geboortedatum (optioneel)">
        <label class="consent-row">
          <input type="checkbox" id="reg-privacy" required>
          <span>Ik ga akkoord met de privacyvoorwaarden</span>
        </label>
        <label class="consent-row">
          <input type="checkbox" id="reg-marketing" checked>
          <span>Ik wil aanbiedingen en nieuws ontvangen (optioneel)</span>
        </label>
        <button class="btn-primary" id="complete-registration-btn">Account aanmaken</button>
        <div class="error-text" id="register-error"></div>
      </div>
    </div>

    <div class="screen" id="screen-dashboard">
      <div id="tab-overview">
        <div class="card-box">
          <div class="name" id="db-name">—</div>
          <div class="credit-label" id="db-credit-label">—</div>
          <div class="big-balance" id="db-balance">—</div>
          <div class="qr-wrap"><img id="db-qr" src="" alt="Mijn QR-code"></div>
          <div class="scan-hint">Laat scannen bij de kassa</div>
        </div>

        <div class="expiring-note" id="db-expiring" style="display:none;"></div>

        <div class="section-title">Cadeaukaarten</div>
        <div id="db-giftcards"></div>

        <div class="section-title">Recente mutaties</div>
        <div id="db-recent"></div>
      </div>

      <div id="tab-rewards" style="display:none;">
        <p style="font-size:13px;color:var(--muted);margin:0 0 16px;">Vandaag beschikbaar — laat je pas scannen bij de kassa om in te wisselen.</p>
        <div class="section-title" style="margin-top:0;">Wat je tegoed waard is</div>
        <div id="db-rate-table"></div>
        <div class="section-title">Cadeaus</div>
        <div id="db-rewards"></div>
      </div>

      <div id="tab-history" style="display:none;">
        <div class="section-title" style="margin-top:0;">Recente historie</div>
        <div id="db-history"></div>
      </div>

      <div id="tab-profile" style="display:none;">
        <div class="section-title" style="margin-top:0;">Profiel</div>
        <div class="list-item"><div class="item-name" id="profile-name">—</div><div class="item-meta" id="profile-email"></div></div>
        <p style="font-size:12px;color:var(--muted);margin-top:16px;">Wil je je gegevens wijzigen of je account laten verwijderen? Neem contact op met de zaak.</p>
      </div>

      <nav class="tabbar">
        <button class="tab-btn active" data-tab="overview">Overzicht</button>
        <button class="tab-btn" data-tab="rewards">Cadeaus</button>
        <button class="tab-btn" data-tab="history">Historie</button>
        <button class="tab-btn" data-tab="profile">Profiel</button>
      </nav>
    </div>

  </main>
</div>

<script>
  const ORG_ID = ${JSON.stringify(orgId)};
  const API_BASE = ${JSON.stringify(API_BASE)};
  const CREDIT_LABEL = ${JSON.stringify(brand.creditLabel)};
  const STORAGE_KEY = 'mijn_tegoed_session';

  let pendingEmail = '';
  let pendingRegistrationId = null;

  // -- Hoogte doorgeven aan de omringende pagina (bijv. een WordPress-
  // iframe-embed) — zodat de HELE pagina normaal scrolt in plaats van
  // een vastgezet, intern scrollend vakje. Vooral op mobiel belangrijk:
  // een vaste 100vh-iframe botst daar al snel met de eigen menubalk van
  // de omringende site. -----------------------------------------------

  function reportHeight() {
    const height = document.body.scrollHeight;
    window.parent.postMessage({ type: 'mijn-tegoed-resize', height: height }, '*');
  }
  // Direct na laden, én na elke schermwissel (inhoud/hoogte verandert
  // dan), én als vangnet elke halve seconde (voor content die zonder
  // een duidelijk "klaar"-moment van hoogte verandert, zoals een
  // langzaam ladende afbeelding).
  window.addEventListener('load', reportHeight);
  setInterval(reportHeight, 500);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
    document.getElementById('logout-btn').style.display = id === 'screen-dashboard' ? 'block' : 'none';
    setTimeout(reportHeight, 50);
  }

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + '/guest-app/organizations/' + ORG_ID + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || 'Er ging iets mis');
    return data;
  }

  async function apiGet(path, token) {
    const res = await fetch(API_BASE + '/guest-app/organizations/' + ORG_ID + path, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || 'Er ging iets mis');
    return data;
  }

  document.getElementById('request-code-btn').addEventListener('click', async function () {
    const email = document.getElementById('email-input').value.trim();
    const errorEl = document.getElementById('email-error');
    errorEl.textContent = '';
    if (!email) { errorEl.textContent = 'Vul een e-mailadres in.'; return; }
    try {
      await apiPost('/auth/request-code', { email: email });
      pendingEmail = email;
      showScreen('screen-code');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('back-to-email-btn').addEventListener('click', function () { showScreen('screen-email'); });

  document.getElementById('verify-code-btn').addEventListener('click', async function () {
    const code = document.getElementById('code-input').value.trim();
    const errorEl = document.getElementById('code-error');
    errorEl.textContent = '';
    try {
      const result = await apiPost('/auth/verify-code', { email: pendingEmail, code: code });
      if (result.requiresRegistration) {
        pendingRegistrationId = result.verifiedRegistrationId;
        showScreen('screen-register');
      } else {
        localStorage.setItem(STORAGE_KEY, result.token);
        loadDashboard(result.token);
      }
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('complete-registration-btn').addEventListener('click', async function () {
    const errorEl = document.getElementById('register-error');
    errorEl.textContent = '';
    if (!document.getElementById('reg-privacy').checked) {
      errorEl.textContent = 'Je moet akkoord gaan met de privacyvoorwaarden.';
      return;
    }
    const firstName = document.getElementById('reg-firstname').value.trim();
    if (!firstName) { errorEl.textContent = 'Vul je voornaam in.'; return; }
    try {
      const result = await apiPost('/auth/complete-registration', {
        firstName: firstName,
        lastName: document.getElementById('reg-lastname').value.trim() || undefined,
        email: pendingEmail,
        phone: document.getElementById('reg-phone').value.trim() || undefined,
        dateOfBirth: document.getElementById('reg-dob').value || undefined,
        marketingConsent: document.getElementById('reg-marketing').checked,
        verifiedRegistrationId: pendingRegistrationId,
      });
      localStorage.setItem(STORAGE_KEY, result.token);
      loadDashboard(result.token);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  let currentSessionToken = null;

  async function loadDashboard(token) {
    showScreen('screen-dashboard');
    currentSessionToken = token;
    try {
      const results = await Promise.all([
        apiGet('/me', token),
        apiGet('/me/gift-cards', token),
        apiGet('/rewards', token),
        apiGet('/me/activity', token),
        apiGet('/me/qr-token', token),
        apiGet('/redemption-rates', token),
      ]);
      const me = results[0];
      const giftCards = results[1];
      const rewards = results[2];
      const activity = results[3];
      const qr = results[4];
      const rates = results[5];

      document.getElementById('db-name').textContent = [me.firstName, me.lastName].filter(Boolean).join(' ') || 'Gast';
      document.getElementById('db-credit-label').textContent = CREDIT_LABEL;
      document.getElementById('db-balance').textContent = Math.round(Number(me.balance)) + ' pt';
      document.getElementById('db-qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=190x190&data=' + encodeURIComponent(qr.token);

      if (me.expiringSoon) {
        const d = new Date(me.expiringSoon.expiresAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
        document.getElementById('db-expiring').style.display = 'block';
        document.getElementById('db-expiring').textContent = '€' + Number(me.expiringSoon.amount).toFixed(2) + ' Beach Credit verloopt op ' + d;
      }

      const giftCardsEl = document.getElementById('db-giftcards');
      if (giftCards.length === 0) {
        giftCardsEl.innerHTML = '<div class="empty-note">Geen cadeaukaarten gekoppeld.</div>';
      } else {
        giftCardsEl.innerHTML = giftCards.map(function (c) {
          return '<div class="list-item gc-item" data-gc-id="' + c.id + '" style="cursor:pointer;">'
            + '<div class="top-row"><span class="item-name">Gift Card ' + c.maskedNumber + '</span><span class="item-value">€' + Number(c.currentBalance).toFixed(2) + '</span></div>'
            + '<div class="item-meta" style="margin-top:4px;">Tik om te bekijken en te gebruiken</div>'
            + '<div class="gc-qr-area" style="display:none;text-align:center;margin-top:14px;"></div>'
            + '</div>';
        }).join('');

        document.querySelectorAll('.gc-item').forEach(function (item) {
          item.addEventListener('click', async function () {
            const qrArea = item.querySelector('.gc-qr-area');
            if (qrArea.style.display === 'block') { qrArea.style.display = 'none'; return; }
            qrArea.style.display = 'block';
            qrArea.innerHTML = '<div style="font-size:12px;color:var(--muted);">Laden…</div>';
            try {
              const res = await fetch(API_BASE + '/guest-app/organizations/' + ORG_ID + '/me/gift-cards/' + item.dataset.gcId + '/view-token', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + currentSessionToken },
              });
              const data = await res.json();
              const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(data.token);
              qrArea.innerHTML = '<div style="background:white;border-radius:12px;padding:10px;display:inline-block;"><img src="' + qrUrl + '" width="160" height="160" alt="Cadeaukaart-QR"></div>'
                + '<div style="font-family:monospace;font-size:13px;background:var(--cream);border-radius:6px;padding:8px;margin-top:10px;word-break:break-all;">' + data.token + '</div>'
                + '<div style="font-size:11px;color:var(--muted);margin-top:6px;">Laat scannen bij de kassa</div>';
            } catch (err) {
              qrArea.innerHTML = '<div style="font-size:12px;color:var(--accent-dark);">Kon niet laden — probeer opnieuw.</div>';
            }
          });
        });
      }

      const DAY_LABELS_SHORT = { monday: 'ma', tuesday: 'di', wednesday: 'wo', thursday: 'do', friday: 'vr', saturday: 'za', sunday: 'zo' };
      function formatDayRange(days) {
        if (!days || days.length === 0) return 'elke dag';
        var labels = days.map(function (d) { return (DAY_LABELS_SHORT[d] || d).toUpperCase(); });
        return labels.length === 1 ? labels[0] : labels[0] + '–' + labels[labels.length - 1];
      }
      const rateTableEl = document.getElementById('db-rate-table');
      if (!rates || rates.length === 0) {
        rateTableEl.innerHTML = '<div class="empty-note">Geen wisselkoersinformatie beschikbaar.</div>';
      } else {
        rateTableEl.innerHTML = '<div class="list-item">' + rates.map(function (r) {
          var euro = r.blockSize ? Number(r.blockEuroValue).toFixed(2) : null;
          var valueText = r.blockSize ? (r.blockSize + ' pt = €' + euro) : (r.pointsPerEuro + ' pt/€');
          return '<div class="top-row" style="padding:6px 0;"><span class="item-name">' + formatDayRange(r.appliesOnDays) + '</span><span class="item-value">' + valueText + '</span></div>';
        }).join('') + '</div>';
      }

      const rewardsEl = document.getElementById('db-rewards');
      if (rewards.length === 0) {
        rewardsEl.innerHTML = '<div class="empty-note">Vandaag geen cadeaus beschikbaar.</div>';
      } else {
        rewardsEl.innerHTML = rewards.map(function (r) {
          const locBadge = r.location ? '<div class="location-badge">Alleen geldig bij ' + r.location.name + '</div>' : '';
          return '<div class="list-item"><div class="top-row"><span class="item-name">' + r.name + '</span><span class="item-value">' + r.pointsCost + ' pt</span></div>' + locBadge + '</div>';
        }).join('');
      }

      const ENTRY_LABELS = { earn: 'Gespaard', redeem: 'Besteed', bonus: 'Bonus', migration_import: 'Overgezet saldo', transfer: 'Overgeboekt', correction: 'Correctie', sale: 'Cadeaukaart gekocht', top_up: 'Opgewaardeerd' };
      function renderActivityRow(a) {
        const date = new Date(a.occurredAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
        const label = (ENTRY_LABELS[a.type] || a.type) + (a.source === 'gift_card' ? ' (' + a.giftCardNumber + ')' : '');
        const amt = Number(a.amount);
        return '<div class="history-row"><span>' + label + '<br><span style="color:var(--muted);font-size:11px;">' + date + '</span></span><span class="amount ' + (amt >= 0 ? 'positive' : 'negative') + '">' + (amt >= 0 ? '+' : '') + Math.round(Math.abs(amt)) + ' pt</span></div>';
      }

      const recentEl = document.getElementById('db-recent');
      recentEl.innerHTML = activity.length === 0
        ? '<div class="empty-note">Nog geen mutaties.</div>'
        : '<div class="list-item">' + activity.slice(0, 3).map(renderActivityRow).join('') + '</div>';

      const historyEl = document.getElementById('db-history');
      if (activity.length === 0) {
        historyEl.innerHTML = '<div class="empty-note">Nog geen historie.</div>';
      } else {
        historyEl.innerHTML = activity.map(function (a) {
          const date = new Date(a.occurredAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
          const label = (ENTRY_LABELS[a.type] || a.type) + (a.source === 'gift_card' ? ' (' + a.giftCardNumber + ')' : '');
          const amt = Number(a.amount);
          return '<div class="history-row"><span>' + label + '<br><span style="color:var(--muted);font-size:11px;">' + date + '</span></span><span class="amount ' + (amt >= 0 ? 'positive' : 'negative') + '">' + (amt >= 0 ? '+' : '') + '€' + Math.abs(amt).toFixed(2) + '</span></div>';
        }).join('');
      }

      document.getElementById('profile-name').textContent = [me.firstName, me.lastName].filter(Boolean).join(' ');
      document.getElementById('profile-email').textContent = pendingEmail || '';
    } catch (err) {
      localStorage.removeItem(STORAGE_KEY);
      showScreen('screen-email');
    }
  }

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      ['overview', 'rewards', 'history', 'profile'].forEach(function (t) {
        document.getElementById('tab-' + t).style.display = t === btn.dataset.tab ? 'block' : 'none';
      });
    });
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  const savedToken = localStorage.getItem(STORAGE_KEY);
  if (savedToken) loadDashboard(savedToken);
</script>
</body>
</html>`;
  }
}
