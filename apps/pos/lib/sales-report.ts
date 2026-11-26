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
/** The plugin's `TallySalesReportV3`: v2 plus the median and largest order total and sales by collection. */
export type SalesReportV3 = Omit<SalesReportV2, 'version' | 'orders'> & {
  version: 3;
  orders: SalesReportV2['orders'] & { medianMinor: number; largestMinor: number | null };
  categories: { collectionId: string; name: string; quantity: number; salesMinor: number }[];
};
/**
 * The plugin's `TallySalesReportV4`: v3 plus the cash roundings (TallyUI ADR-094). `salesMinor` is the sales' rounding,
 * already in `orders.salesMinor`; `refundedMinor` is the rounding full refunds returned, already in `refunds.totalMinor`.
 */
export type SalesReportV4 = Omit<SalesReportV3, 'version'> & {
  version: 4;
  cashRounding: { salesMinor: number; orderCount: number; unexplainedOrderCount: number; refundedMinor: number; refundCount: number; netMinor: number };
};
export type SalesReport = SalesReportV2 | SalesReportV3 | SalesReportV4;
export type SalesReportQuery = { from: string; to: string; timezone: string; registerId?: string; cashierId?: string };
export type SalesReportOutcome =
  | { status: 'ok'; report: SalesReport }
  | { status: 'unsupported' } // 404: a plugin older than the v2 report
  | { status: 'forbidden' } // 403: the account lacks TallyPosSell or ReadOrder
  | { status: 'error'; message: string };
type Init = { signal?: AbortSignal };

/** GET /tally/v1/reports/sales/v2: the store's figures for a range, optionally for one register or cashier. */
export const fetchSalesReportV2 = (session: Session, query: SalesReportQuery, init?: Init) => fetchReport('v2', session, query, init);

/**
 * v4 first; a plugin older than v4 (404) answers v3, one older than v3 answers v2, and one older than v2 is unsupported,
 * as v2 alone answers. Any other answer (a refusal, an error) is final: it never falls back.
 */
export async function fetchSalesReport(session: Session, query: SalesReportQuery, init?: Init): Promise<SalesReportOutcome> {
  const v4 = await fetchReport('v4', session, query, init);
  if (v4.status !== 'unsupported') return v4;
  const v3 = await fetchReport('v3', session, query, init);
  return v3.status === 'unsupported' ? fetchSalesReportV2(session, query, init) : v3;
}

async function fetchReport(version: 'v2' | 'v3' | 'v4', session: Session, query: SalesReportQuery, init?: Init): Promise<SalesReportOutcome> {
  const params = new URLSearchParams({ from: query.from, to: query.to, timezone: query.timezone });
  if (query.registerId !== undefined) params.set('registerId', query.registerId);
  if (query.cashierId !== undefined) params.set('cashierId', query.cashierId);
  try {
    const response = await fetch(`${session.url}/tally/v1/reports/sales/${version}?${params}`, {
      headers: sessionContext(session).headers, signal: init?.signal,
    });
    if (response.status === 404) return { status: 'unsupported' };
    if (response.status === 403) return { status: 'forbidden' };
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && body && typeof body === 'object') return { status: 'ok', report: body as SalesReport };
    const message = (body as { message?: unknown } | null)?.message;
    return { status: 'error', message: typeof message === 'string' ? message : `Sales report failed (HTTP ${response.status})` };
  } catch (error) {
    if ((error as { name?: unknown })?.name === 'AbortError') throw error;
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
