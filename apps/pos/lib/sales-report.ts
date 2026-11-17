import { sessionContext, type Session } from './session';

/**
 * The plugin's `TallySalesReportV2` (packages/vendure-plugin/src/service/report.service.ts), copied so the app never
 * imports plugin source. Every figure is integer minor units; sorts are code-unit order.
 */
export type SalesReportV2 = {
  version: 2;
  from: string; to: string; timezone: string; currencyCode: string;
  registerId: string | null; cashierId: string | null;
  orders: { count: number; salesMinor: number; taxMinor: number; discountsMinor: number; itemCount: number };
  refunds: { count: number; totalMinor: number; orderCount: number };
  byMethod: { method: string; salesMinor: number; refundsMinor: number; orderCount: number; refundCount: number }[];
  byDay: { day: string; orderCount: number; salesMinor: number; refundsMinor: number }[];
  byHour: { hour: string; orderCount: number; salesMinor: number; refundsMinor: number }[];
  products: { productVariantId: string; sku: string; name: string; quantity: number; salesMinor: number }[];
  productsTruncated: boolean;
  taxes: { description: string; ratePercent: number; baseMinor: number; taxMinor: number }[];
};
export type SalesReportQuery = { from: string; to: string; timezone: string; registerId?: string; cashierId?: string };
export type SalesReportOutcome =
  | { status: 'ok'; report: SalesReportV2 }
  | { status: 'unsupported' } // 404: a plugin older than the v2 report
  | { status: 'forbidden' } // 403: the account lacks TallyPosSell or ReadOrder
  | { status: 'error'; message: string };

/** GET /tally/v1/reports/sales/v2: the store's figures for a range, optionally for one register or cashier. */
export async function fetchSalesReportV2(
  session: Session,
  query: SalesReportQuery,
  init?: { signal?: AbortSignal },
): Promise<SalesReportOutcome> {
  const params = new URLSearchParams({ from: query.from, to: query.to, timezone: query.timezone });
  if (query.registerId !== undefined) params.set('registerId', query.registerId);
  if (query.cashierId !== undefined) params.set('cashierId', query.cashierId);
  try {
    const response = await fetch(`${session.url}/tally/v1/reports/sales/v2?${params}`, {
      headers: sessionContext(session).headers, signal: init?.signal,
    });
    if (response.status === 404) return { status: 'unsupported' };
    if (response.status === 403) return { status: 'forbidden' };
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && body && typeof body === 'object') return { status: 'ok', report: body as SalesReportV2 };
    const message = (body as { message?: unknown } | null)?.message;
    return { status: 'error', message: typeof message === 'string' ? message : `Sales report failed (HTTP ${response.status})` };
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError') throw error;
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
