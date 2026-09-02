import { ForbiddenException } from '@nestjs/common';
import type { RequestContext } from './decorators/current-context.decorator';

/**
 * Bepaalt de locatie waarop een mutatie geboekt wordt, voor endpoints
 * die (afhankelijk van de aanroeper) zowel een expliciet meegegeven
 * locationId als een automatisch-aan-de-medewerker-gekoppelde locatie
 * kunnen hebben — kadobon-uitgifte/-inwisseling, tegoed-afboeking,
 * punteninwisseling, voucher-inwisseling.
 *
 * Regel (zoals expliciet gevraagd — "de medewerker hoeft niet
 * handmatig een locatie te kiezen, en mag ook geen andere kunnen
 * opgeven"):
 *   - Heeft de ingelogde medewerker een `homeLocationId` (bijv. de
 *     kassa-accounts kassa@het-strand.nl / kassa@zomersbeachclub.nl),
 *     dan wordt ALTIJD die locatie gebruikt — een eventueel door de
 *     client meegegeven `requestedLocationId` wordt genegeerd. Wijkt
 *     die client-waarde af van de eigen homeLocationId, dan is dat een
 *     duidelijk teken van een gemanipuleerd verzoek (een kassa-account
 *     hoort dat veld immers nooit zelf in te vullen) — dat wordt hard
 *     geweigerd (403), niet stilzwijgend gecorrigeerd, zodat zoiets
 *     zichtbaar wordt i.p.v. onopgemerkt te blijven.
 *   - Heeft de medewerker GEEN homeLocationId (bijv. kantoor/
 *     administratie-accounts, die wél over meerdere locaties werken),
 *     dan wordt gewoon de door de client opgegeven locationId gebruikt
 *     — exact het bestaande gedrag van vóór deze wijziging.
 *
 * Nooit vertrouwen op een frontend-waarde als er een homeLocationId is
 * — dit is de server-side afdwinging die de opdracht expliciet vereist.
 */
export function resolveLocationId(ctx: RequestContext, requestedLocationId: string): string;
export function resolveLocationId(ctx: RequestContext, requestedLocationId: string | undefined | null): string | undefined;
export function resolveLocationId(ctx: RequestContext, requestedLocationId: string | undefined | null): string | undefined {
  if (ctx.homeLocationId) {
    if (requestedLocationId && requestedLocationId !== ctx.homeLocationId) {
      throw new ForbiddenException(
        'Deze medewerker is gekoppeld aan een vaste locatie en kan geen mutatie boeken op een andere locatie.',
      );
    }
    return ctx.homeLocationId;
  }
  return requestedLocationId ?? undefined;
}
