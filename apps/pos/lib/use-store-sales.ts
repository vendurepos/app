import { useEffect, useState } from 'react';
import type { SalesFilters } from '@tallyui/components';
import { comparisonRange, orderFiltersQuery, type DayRange } from '@tallyui/pos';
import { fetchSalesReportV2 } from './sales-report';
import type { Session } from './session';
import { shownStore, storeAnswer, type StoreSales } from './store-sales';
import { isOneDay } from './till-reports';

// The browser's online signal, as app/index.tsx reads it; a platform without navigator counts as online.
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * The store's figures for the Reports filters (8.1f): GET /tally/v1/reports/sales/v2 for the range and again for its
 * comparison range. The route has no sync status, so the status filter is not sent. `refreshKey` refetches when it
 * changes (a sale or refund reaching the store).
 */
export function useStoreSales({ session, filters, timezone, refreshKey }: {
  session: Session | null; filters: SalesFilters; timezone: string; refreshKey: string;
}): StoreSales {
  const [online, setOnline] = useState(isOnline);
  // The state with the query (null unless ok) and the session it answered, so a stale answer is never shown.
  const [store, setStore] = useState<{ value: StoreSales; key: string | null; session: Session | null }>(
    () => ({ value: { status: 'loading' }, key: null, session }));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const { range, preset, compare: mode, registerId, cashierId } = filters;
  const key = JSON.stringify([range.from, range.to, preset, mode, registerId, cashierId, timezone]);
  // The stored answer's query, unless it came under another session: then it answered nothing asked now.
  const okKeyNow = (current: typeof store) => (current.session === session ? current.key : null);
  useEffect(() => {
    const settle = (value: StoreSales) => setStore({ value, key: value.status === 'ok' ? key : null, session });
    if (!online) { settle({ status: 'offline' }); return; }
    if (!session) { settle({ status: 'unsupported' }); return; }
    // A refresh of the same query (only refreshKey moved) keeps the store's figures until the new ones come.
    setStore((current) => (shownStore(current.value, okKeyNow(current), key).status === 'ok'
      ? current : { value: { status: 'loading' }, key: null, session }));
    const day: DayRange = { from: range.from, to: range.to };
    const compare = comparisonRange(day, mode, preset === 'custom' ? undefined : preset);
    const controller = new AbortController();
    const fetchRange = (r: DayRange) => {
      const { after, before } = orderFiltersQuery({ dateRange: r }, timezone).dateRange ?? {};
      return fetchSalesReportV2(session, { from: after ?? '', to: before ?? '', timezone,
        registerId: registerId || undefined, cashierId: cashierId || undefined }, { signal: controller.signal });
    };
    Promise.all([fetchRange(day), fetchRange(compare)]).then(([a, b]) => {
      if (controller.signal.aborted) return; // answered after the filters moved on
      settle(storeAnswer(a, b, day, compare, isOneDay(filters)));
    }, (error: unknown) => {
      if ((error as { name?: unknown })?.name !== 'AbortError') settle({ status: 'error' });
    });
    return () => controller.abort();
    // filters is read only through the fields listed, so a new object with the same fields does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, online, range.from, range.to, preset, mode, registerId, cashierId, timezone, refreshKey]);
  // On the render where the filters or the session change, before the effect runs, the old figures are not shown.
  return shownStore(store.value, okKeyNow(store), key);
}
