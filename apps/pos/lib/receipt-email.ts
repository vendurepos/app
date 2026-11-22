import type { ServerCapabilities, SyncContext } from '@tallyui/core';

/** The address was refused (400 invalid_payload) or the order has no usable one (422 no_recipient). */
export const RECEIPT_EMAIL_INVALID_TEXT = 'Enter one email address, such as name@example.com.';
/** The store's plugin has receipt email off, or predates the route (a 404 with no code). */
export const RECEIPT_EMAIL_DISABLED_TEXT = "This store doesn't email receipts. The store's admin can turn it on in the VendurePOS plugin.";
/** The plugin's own 403 `forbidden`: the role reaches the route but lacks ReadOrder. */
export const RECEIPT_EMAIL_FORBIDDEN_TEXT = "This account can't email receipts. Ask the store's admin to add the Read order permission to its role.";
/** A 401, or a 403 without the plugin's `forbidden` code: Vendure's AuthGuard refusal, which ADR 0023 reads as sign in again. */
export const RECEIPT_EMAIL_UNAUTHORIZED_TEXT = 'This till needs to sign in again. Sign in, then send the receipt again.';
/** The order code is no longer in the store's channel (404 order_not_found). */
export const RECEIPT_EMAIL_ORDER_GONE_TEXT = "This order isn't in the store any more.";
/** The order was not made on a till (409 not_till_order). */
export const RECEIPT_EMAIL_NOT_TILL_ORDER_TEXT = 'Only sales made on a till can have their receipt emailed here.';
/** The per-user per-minute cap was hit (429 rate_limited). */
export const RECEIPT_EMAIL_RATE_LIMITED_TEXT = 'Too many receipts sent just now. Wait a minute, then try again.';
/** The order's own send cap was hit (429 order_send_limit). */
export const RECEIPT_EMAIL_ORDER_LIMIT_TEXT = "This order's receipt has been emailed as many times as the store allows.";
/** A user or channel daily cap was hit (429 user_daily_limit or channel_daily_limit). */
export const RECEIPT_EMAIL_DAILY_LIMIT_TEXT = 'The daily limit for emailed receipts has been reached.';
/** The request threw (network, timeout) or a timeout or gateway status answered (408, 502, 503, 504, 524), so the send may or may not have happened. */
export const RECEIPT_EMAIL_UNKNOWN_TEXT = "The store didn't answer, so the receipt may or may not have been sent. Check with the customer before sending it again.";
/** Any other answer: another 5xx, an unknown code, a non-JSON body or a 2xx that is not the route's. */
export const RECEIPT_EMAIL_FAILED_TEXT = "Can't send the receipt. Try again.";

// A hung send must end. The route is not idempotent, so a timeout reads as unknown (RECEIPT_EMAIL_UNKNOWN_TEXT), never as a retry.
export const RECEIPT_EMAIL_TIMEOUT_MS = 20_000;
// Answers that may come after the store sent the email: a request timeout (408), a gateway's error (502, 503, 504) or Cloudflare's timeout (524).
const UNKNOWN_STATUSES = new Set([408, 502, 503, 504, 524]);

// The cashier text for each `status code` refusal the plugin's receipt-email route writes (packages/vendure-plugin/README.md, "Receipt email").
const REFUSALS: Record<string, string> = {
  '400 invalid_payload': RECEIPT_EMAIL_INVALID_TEXT, '422 no_recipient': RECEIPT_EMAIL_INVALID_TEXT,
  '404 receipt_email_disabled': RECEIPT_EMAIL_DISABLED_TEXT, '404 order_not_found': RECEIPT_EMAIL_ORDER_GONE_TEXT,
  '409 not_till_order': RECEIPT_EMAIL_NOT_TILL_ORDER_TEXT, '429 rate_limited': RECEIPT_EMAIL_RATE_LIMITED_TEXT,
  '429 order_send_limit': RECEIPT_EMAIL_ORDER_LIMIT_TEXT, '429 user_daily_limit': RECEIPT_EMAIL_DAILY_LIMIT_TEXT,
  '429 channel_daily_limit': RECEIPT_EMAIL_DAILY_LIMIT_TEXT,
};

/** Whether the store advertises the receipt-email route (`receiptEmail: { v }` with v of at least 1 on /tally/v1/info). */
export function canEmailReceipt(capabilities: ServerCapabilities | undefined): boolean {
  const version = capabilities?.receiptEmail;
  return typeof version === 'number' && version >= 1;
}

/**
 * Asks the store to email the receipt of order `orderCode` to `address`: null when queued, else the cashier text.
 * The route is not idempotent (each accepted call sends one email), so this never retries; it never logs the address or the body.
 */
export async function sendReceiptEmail(context: SyncContext, orderCode: string, address: string): Promise<string | null> {
  // One timer covers the request and the body read; an abort rejects either, as a network failure would. A body read
  // cut off by it is unknown whatever the status (a 202 may have sent); a body read in full that isn't the route's stays FAILED.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RECEIPT_EMAIL_TIMEOUT_MS);
  let response: Response;
  let body: { queued?: unknown; code?: unknown; retryAt?: unknown } | null;
  try {
    try {
      response = await fetch(`${context.baseUrl}/tally/v1/orders/${encodeURIComponent(orderCode)}/receipt-email`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...context.headers }, body: JSON.stringify({ emailAddress: address.trim() }),
        signal: abort.signal });
    } catch { return RECEIPT_EMAIL_UNKNOWN_TEXT; }
    body = await response.json().catch(() => null);
  } finally { clearTimeout(timer); }
  if (abort.signal.aborted) return RECEIPT_EMAIL_UNKNOWN_TEXT;
  // Queued only on the route's own answer: a 2xx from anything else (a proxy's page) sent nothing.
  if (response.status === 202 && body?.queued === true) return null;
  if (UNKNOWN_STATUSES.has(response.status)) return RECEIPT_EMAIL_UNKNOWN_TEXT;
  const code = typeof body?.code === 'string' ? body.code : undefined;
  if (response.status === 401 || response.status === 403) return code === 'forbidden' ? RECEIPT_EMAIL_FORBIDDEN_TEXT : RECEIPT_EMAIL_UNAUTHORIZED_TEXT;
  if (response.status === 404 && !code) return RECEIPT_EMAIL_DISABLED_TEXT;
  const text = (code !== undefined && REFUSALS[`${response.status} ${code}`]) || RECEIPT_EMAIL_FAILED_TEXT;
  const retryAt = text === RECEIPT_EMAIL_DAILY_LIMIT_TEXT && typeof body?.retryAt === 'string' ? Date.parse(body.retryAt) : NaN;
  return Number.isNaN(retryAt) ? text : `${text} Try again after ${new Date(retryAt).toLocaleString()}.`;
}
