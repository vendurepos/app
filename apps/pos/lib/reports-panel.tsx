import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Button, SalesCardPanel, SalesCards, SalesFiltersBar, Tabs, TabsList, TabsTrigger, Text, VStack, type SalesPanelId } from '@tallyui/components';
import type { PosOrder, PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { printLines } from './print-lines';
import { cardPanel, panelCsvFileName, panelScope } from './reports-card-panels';
import { salesCsv, salesCsvFileName } from './sales-csv';
import { salesSummaryLines } from './sales-summary-lines';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillHourly, tillOrderSpread, tillSalesFigures } from './till-reports';
import type { Session } from './session';
import { reportsView, type ReportsView } from './store-sales';
import { TillSalesHero } from './till-sales-hero';
import { useFreshList } from './use-fresh-list';
import { useStoreSales } from './use-store-sales';

// The desk's 8.1q ruling: the store's Categories card counts a product in every collection it is in, and says so.
// TallyUI 4.2.0's cards take no help text, so the app shows the line, as it shows the till-only caption.
export const CATEGORIES_HELP_TEXT = 'Categories: a product in several collections counts in each.';

/** The help line only over the store's Categories card (a v3 answer); the till view and a v2 answer have none. */
export function categoriesHelp(view: Pick<ReportsView, 'storeWide' | 'hide'>): string | null {
  return view.storeWide && !view.hide.includes('categories') ? CATEGORIES_HELP_TEXT : null;
}

export function ReportsPanel({ session, orders, refunds, currency, timezone, drawer, closures, onOpenOrders }: {
  session: Session | null; orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; drawer?: ReactNode; closures?: ReactNode;
  onOpenOrders: () => void;
}) {
  const [tab, setTab] = useState('sales');
  const [openCard, setOpenCard] = useState<SalesPanelId | null>(null);
  const orderList = useFreshList(orders);
  const refundList = useFreshList(refunds);
  const [filters, setFilters] = useState(() => initialSalesFilters(new Date(), timezone));
  const [printFailed, setPrintFailed] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  // A sale or refund reaching the store changes the key, so the store's figures are fetched again.
  const refreshKey = `${orderList.filter((order) => order.syncStatus === 'applied').length}:${refundList.filter((refund) => refund.status === 'applied').length}`;
  const store = useStoreSales({ session, filters, timezone, refreshKey });
  // The store's figures when they came (8.1f), else this till's own: never a mix of the two.
  const view = useMemo(() => reportsView(store, () => ({
    figures: tillSalesFigures({ orders: orderList, refunds: refundList, filters, timezone }),
    hourly: tillHourly({ orders: orderList, filters, timezone }),
    spread: tillOrderSpread({ orders: orderList, filters, timezone }),
  }), REPORT_STATUS_OPTIONS), [store, orderList, refundList, filters, timezone]);
  const categoriesHelpText = categoriesHelp(view);
  useEffect(() => { if (openCard && view.hide.includes(openCard)) setOpenCard(null); }, [openCard, view.hide]);
  // The web downloads the period's figures as the closures sheet does: a Blob URL on an <a download>.
  const downloadCsv = (csv: string, filename: string) => {
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
    }
  };
  const exportCsv = () => {
    setExportFailed(false);
    downloadCsv(salesCsv(view.figures, currency, view.tillOnly), salesCsvFileName(view.figures, view.tillOnly));
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
          {/* data-status tells loading from a refusal, which read the same line; TallyUI's Text takes no dataSet. */}
          {view.tillOnly ? (
            <View testID="reports-till-only" dataSet={{ status: store.status }}>
              <Text className="text-sm text-muted-foreground">{view.tillOnly}</Text>
            </View>
          ) : null}
          {categoriesHelpText ? (
            <Text testID="reports-categories-help" className="text-sm text-muted-foreground">{categoriesHelpText}</Text>
          ) : null}
          <TillSalesHero figures={view.figures} filters={filters} onFiltersChange={setFilters} currency={currency} hourly={view.hourly} spread={view.spread} />
          <View dataSet={{ print: 'hide' }} className="gap-1">
            <View className="flex-row gap-2">
              <Button testID="reports-print-summary" variant="secondary" onPress={() => {
                setPrintFailed(false);
                printLines('Sales summary', salesSummaryLines(view.figures, currency, view.tillOnly)).catch(() => setPrintFailed(true));
              }}><Text>Print summary</Text></Button>
              {Platform.OS === 'web' ? (
                <Button testID="reports-export-csv" variant="secondary" onPress={exportCsv}><Text>Export CSV</Text></Button>
              ) : null}
            </View>
            {printFailed ? <Text testID="reports-print-error" className="text-sm text-destructive">Printing failed. Try again.</Text> : null}
            {exportFailed ? <Text testID="reports-export-error" className="text-sm text-destructive">Export failed. Try again.</Text> : null}
          </View>
          <SalesCards figures={view.figures} currency={currency} hide={view.hide} onOpenCard={(card) => {
            const panel = cardPanel(card);
            if (panel) setOpenCard(panel);
            else onOpenOrders();
          }} />
        </View>
      </ScrollView>
      {/* v2's card panels; a card the view hides closes its panel, and it stays closed, so the store's figures never show under a till-only one. */}
      <SalesCardPanel card={openCard !== null && !view.hide.includes(openCard) ? openCard : null}
        figures={view.figures} currency={currency} scope={panelScope(view.figures, view.tillOnly)}
        onClose={() => setOpenCard(null)}
        onExportCsv={Platform.OS === 'web' ? (csv, filename) => {
          setExportFailed(false);
          downloadCsv(csv, panelCsvFileName(openCard!, filename, view.tillOnly));
        } : undefined} />
    </VStack>
  );
}
