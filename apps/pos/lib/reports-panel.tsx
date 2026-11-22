import { useMemo, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Button, SalesCards, SalesFiltersBar, Tabs, TabsList, TabsTrigger, Text, VStack } from '@tallyui/components';
import type { PosOrder, PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { printLines } from './print-lines';
import { salesCsv, salesCsvFileName } from './sales-csv';
import { salesSummaryLines } from './sales-summary-lines';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillHourly, tillOrderSpread, tillSalesFigures } from './till-reports';
import type { Session } from './session';
import { reportsView } from './store-sales';
import { TillSalesHero } from './till-sales-hero';
import { useFreshList } from './use-fresh-list';
import { useStoreSales } from './use-store-sales';

export function ReportsPanel({ session, orders, refunds, currency, timezone, drawer, closures }: {
  session: Session | null; orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; drawer?: ReactNode; closures?: ReactNode;
}) {
  const [tab, setTab] = useState('sales');
  const orderList = useFreshList(orders);
  const refundList = useFreshList(refunds);
  const [filters, setFilters] = useState(() => initialSalesFilters(new Date(), timezone));
  const [printFailed, setPrintFailed] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  // A sale or refund reaching the store changes the key, so the store's figures are fetched again.
  const refreshKey = `${orderList.filter((order) => order.syncStatus === 'applied').length}:${refundList.length}`;
  const store = useStoreSales({ session, filters, timezone, refreshKey });
  // The store's figures when they came (8.1f), else this till's own: never a mix of the two.
  const view = useMemo(() => reportsView(store, () => ({
    figures: tillSalesFigures({ orders: orderList, refunds: refundList, filters, timezone }),
    hourly: tillHourly({ orders: orderList, filters, timezone }),
    spread: tillOrderSpread({ orders: orderList, filters, timezone }),
  }), REPORT_STATUS_OPTIONS), [store, orderList, refundList, filters, timezone]);
  // The web downloads the period's figures as the closures sheet does: a Blob URL on an <a download>.
  const exportCsv = () => {
    setExportFailed(false);
    try {
      const url = URL.createObjectURL(new Blob([salesCsv(view.figures, currency)], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = salesCsvFileName(view.figures);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
    }
  };
  return (
    <VStack testID="reports-panel" className="flex-1">
      {closures ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList dataSet={{ print: 'hide' }} className="m-2 flex-row">
            <TabsTrigger testID="reports-tab-sales" value="sales" className="flex-1"><Text>Sales</Text></TabsTrigger>
            <TabsTrigger testID="reports-tab-closures" value="closures" className="flex-1"><Text>Closures</Text></TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {closures && tab === 'closures' ? <ScrollView contentContainerClassName="p-4">{closures}</ScrollView> : null}
      <ScrollView contentContainerClassName="p-4" style={closures && tab === 'closures' ? { display: 'none' } : undefined}>
        <View testID="sales-room" className="gap-4">
          {drawer}
          <SalesFiltersBar filters={view.storeWide ? { ...filters, status: 'all' } : filters} onFiltersChange={setFilters} timezone={timezone}
            statusOptions={view.statusOptions} {...reportOptions(orderList)} />
          {view.tillOnly ? <Text testID="reports-till-only" className="text-sm text-muted-foreground">{view.tillOnly}</Text> : null}
          <TillSalesHero figures={view.figures} filters={filters} onFiltersChange={setFilters} currency={currency} hourly={view.hourly} spread={view.spread} />
          <View dataSet={{ print: 'hide' }} className="gap-1">
            <View className="flex-row gap-2">
              <Button testID="reports-print-summary" variant="secondary" onPress={() => {
                setPrintFailed(false);
                printLines('Sales summary', salesSummaryLines(view.figures, currency)).catch(() => setPrintFailed(true));
              }}><Text>Print summary</Text></Button>
              {Platform.OS === 'web' ? (
                <Button testID="reports-export-csv" variant="secondary" onPress={exportCsv}><Text>Export CSV</Text></Button>
              ) : null}
            </View>
            {printFailed ? <Text testID="reports-print-error" className="text-sm text-destructive">Printing failed. Try again.</Text> : null}
            {exportFailed ? <Text testID="reports-export-error" className="text-sm text-destructive">Export failed. Try again.</Text> : null}
          </View>
          <SalesCards figures={view.figures} currency={currency} hide={view.hide} />
        </View>
      </ScrollView>
    </VStack>
  );
}
