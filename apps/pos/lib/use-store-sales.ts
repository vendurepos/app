import { useEffect, useState } from 'react';
import type { SalesFilters } from '@tallyui/components';
import { comparisonRange, orderFiltersQuery, type DayRange } from '@tallyui/pos';
import { fetchSalesReportV2, type SalesReportOutcome } from './sales-report';
import type { Session } from './session';
import { storeHourly, storeSalesFigures, type StoreSales } from './store-sales';
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
  const { range, preset, compare: mode, registerId, cashierId } = filters;
  useEffect(() => {
    if (!online) { setStore({ status: 'offline' }); return; }
    if (!session) { setStore({ status: 'unsupported' }); return; }
    setStore({ status: 'loading' });
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
        setStore({ status: 'ok', figures: storeSalesFigures(a.report, b.report, day, compare),
          hourly: storeHourly(a.report, b.report, day, compare, isOneDay(filters)) });
        return;
      }
      const failed = (status: SalesReportOutcome['status']) => a.status === status || b.status === status;
      setStore({ status: failed('forbidden') ? 'forbidden' : failed('unsupported') ? 'unsupported' : 'error' });
    }, (error: unknown) => {
      if ((error as { name?: unknown })?.name !== 'AbortError') setStore({ status: 'error' });
    });
    return () => controller.abort();
    // filters is read only through the fields listed, so a new object with the same fields does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, online, range.from, range.to, preset, mode, registerId, cashierId, timezone, refreshKey]);
  return store;
}
