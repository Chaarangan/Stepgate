/** Stepgate's version; a test keeps it equal to package.json. */
export const VERSION = "0.1.0";

/**
 * The User-Agent sent on outgoing requests. Some APIs (SEC EDGAR, USAJOBS) require the operator's
 * contact email in it, and SEC rejects the parenthesised form when an email is present.
 */
export function userAgent(contact: string | null): string {
  return contact === null ? `stepgate/${VERSION} (+https://github.com/Chaarangan/stepgate)` : `stepgate/${VERSION} ${contact}`;
}
