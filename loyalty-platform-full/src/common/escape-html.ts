/**
 * Escaped tegen HTML-injectie (stored XSS) — gebruik dit ALTIJD wanneer
 * vrije tekst die door een gebruiker is ingevoerd (persoonlijke
 * boodschap, naam, etc.) in een HTML-string terechtkomt, of het nu een
 * e-mailbody is of een pagina die in de browser wordt gerenderd. Nooit
 * nodig voor platte tekst (e-mail plain-text-versie) of JSON-API-
 * antwoorden — de browser/e-mailclient interpreteert die toch niet als
 * HTML.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
