import { useMemo, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Button, SalesCards, SalesFiltersBar, Tabs, TabsList, TabsTrigger, Text, VStack } from '@tallyui/components';
import type { PosOrder, PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { printLines } from './print-lines';
import { salesCsv, salesCsvFileName } from './sales-csv';
import { salesSummaryLines } from './sales-summary-lines';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillHourly, tillOrderSpread, tillSalesFigures } from './till-reports';
import { TillSalesHero } from './till-sales-hero';
import { useFreshList } from './use-fresh-list';

export function ReportsPanel({ orders, refunds, currency, timezone, drawer, closures }: {
  orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; drawer?: ReactNode; closures?: ReactNode;
}) {
  const [tab, setTab] = useState('sales');
  const orderList = useFreshList(orders);
  const refundList = useFreshList(refunds);
  const [filters, setFilters] = useState(() => initialSalesFilters(new Date(), timezone));
  const [printFailed, setPrintFailed] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const figures = useMemo(() => tillSalesFigures({ orders: orderList, refunds: refundList, filters, timezone }), [orderList, refundList, filters, timezone]);
  const hourly = useMemo(() => tillHourly({ orders: orderList, filters, timezone }), [orderList, filters, timezone]);
  const spread = useMemo(() => tillOrderSpread({ orders: orderList, filters, timezone }), [orderList, filters, timezone]);
  // The web downloads the period's figures as the closures sheet does: a Blob URL on an <a download>.
  const exportCsv = () => {
    setExportFailed(false);
    try {
      const url = URL.createObjectURL(new Blob([salesCsv(figures, currency)], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = salesCsvFileName(figures);
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
          <SalesFiltersBar filters={filters} onFiltersChange={setFilters} timezone={timezone}
            statusOptions={REPORT_STATUS_OPTIONS} {...reportOptions(orderList)} />
          <TillSalesHero figures={figures} filters={filters} onFiltersChange={setFilters} currency={currency} hourly={hourly} spread={spread} />
          <View dataSet={{ print: 'hide' }} className="gap-1">
            <View className="flex-row gap-2">
              <Button testID="reports-print-summary" variant="secondary" onPress={() => {
                setPrintFailed(false);
                printLines('Sales summary', salesSummaryLines(figures, currency)).catch(() => setPrintFailed(true));
              }}><Text>Print summary</Text></Button>
              {Platform.OS === 'web' ? (
                <Button testID="reports-export-csv" variant="secondary" onPress={exportCsv}><Text>Export CSV</Text></Button>
              ) : null}
            </View>
            {printFailed ? <Text testID="reports-print-error" className="text-sm text-destructive">Printing failed. Try again.</Text> : null}
            {exportFailed ? <Text testID="reports-export-error" className="text-sm text-destructive">Export failed. Try again.</Text> : null}
          </View>
          <SalesCards figures={figures} currency={currency} />
        </View>
      </ScrollView>
    </VStack>
  );
}
