import { useEffect, useRef, useState } from 'react';
import type { SalesFilters } from '@tallyui/components';
import { comparisonRange, orderFiltersQuery, type DayRange } from '@tallyui/pos';
import { fetchSalesReportV2, type SalesReportOutcome } from './sales-report';
import type { Session } from './session';
import { storeHourly, storeSalesFigures, whileFetching, type StoreSales } from './store-sales';
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
  const [store, setStore] = useState<StoreSales>({ status: 'loading' });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  // The query the shown `ok` figures answered (null when none is shown), and the session they were fetched under.
  const okKey = useRef<string | null>(null);
  const lastSession = useRef(session);
  const { range, preset, compare: mode, registerId, cashierId } = filters;
  useEffect(() => {
    if (lastSession.current !== session) { lastSession.current = session; okKey.current = null; }
    const key = JSON.stringify([range.from, range.to, preset, mode, registerId, cashierId, timezone]);
    const settle = (next: StoreSales) => { okKey.current = next.status === 'ok' ? key : null; setStore(next); };
    if (!online) { settle({ status: 'offline' }); return; }
    if (!session) { settle({ status: 'unsupported' }); return; }
    // A refresh of the same query (only refreshKey moved) keeps the store's figures until the new ones come.
    setStore((current) => whileFetching(current, okKey.current, key));
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
      if (a.status === 'ok' && b.status === 'ok') {
        settle({ status: 'ok', figures: storeSalesFigures(a.report, b.report, day, compare),
          hourly: storeHourly(a.report, b.report, day, compare, isOneDay(filters)) });
        return;
      }
      const failed = (status: SalesReportOutcome['status']) => a.status === status || b.status === status;
      settle({ status: failed('forbidden') ? 'forbidden' : failed('unsupported') ? 'unsupported' : 'error' });
    }, (error: unknown) => {
      if ((error as { name?: unknown })?.name !== 'AbortError') settle({ status: 'error' });
    });
    return () => controller.abort();
    // filters is read only through the fields listed, so a new object with the same fields does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, online, range.from, range.to, preset, mode, registerId, cashierId, timezone, refreshKey]);
  return store;
}
