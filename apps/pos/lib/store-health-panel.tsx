import { useEffect, useRef, useState, type JSX } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogTitle, HStack, orderReference, Progress, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text, VStack,
} from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { measureCollectionBytes } from '@tallyui/database';
import type { PosOrder } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { sessionContext, type Session } from './session';
import { SyncCadenceCard } from './sync-cadence-card';
import { confirmRedownload, coveragePercent, formatCollectionSize, formatStorageUsed, readServerTotals, readStorageUsed, recordsOnDevice, redownloadBlocked, redownloadSummary, type AttentionRow, type ReadyToSell, type ServerTotals } from './store-health';

export function StoreHealthPanel({ session, ready, waiting, productCount, variantCount, catalogueSynced, collections, attention, onRetry, onOpen, onViewLog, onCheckNow, onRedownload, redownloading }: {
  session: Session; ready: ReadyToSell; waiting: number; productCount: number; variantCount: number; catalogueSynced: boolean;
  collections: { products: RxCollection | null; orders: RxCollection | null; refunds: RxCollection | null; parked: RxCollection | null; closures: RxCollection | null };
  attention: AttentionRow[]; onRetry: (orderIds: string[]) => Promise<number>; onOpen: (order: PosOrder) => void;
  onViewLog: () => void; onCheckNow: () => Promise<void>; onRedownload: () => Promise<void>; redownloading: boolean;
}): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [checkingStore, setCheckingStore] = useState(false);
  const yesWanted = useRef(false);
  function closeConfirm() { yesWanted.current = false; setConfirming(false); }
  async function confirmYes() {
    yesWanted.current = true;
    setCheckingStore(true);
    try { await confirmRedownload(() => readServerTotals(sessionContext(session)), setTotals,
      async () => { closeConfirm(); setCheckingStore(false); await onRedownload(); }, () => yesWanted.current); } finally { setCheckingStore(false); closeConfirm(); }
  }
  async function checkNow() {
    setChecking(true);
    try { await onCheckNow(); } finally { setMeasureRun(run => run + 1); setChecking(false); }
  }
  const { products, orders, refunds, parked, closures } = collections;
  const [counts, setCounts] = useState<Record<'orders' | 'refunds' | 'parked' | 'closures', number | null>>({ orders: null, refunds: null, parked: null, closures: null });
  useEffect(() => {
    setCounts({ orders: null, refunds: null, parked: null, closures: null });
    const sources = { orders, refunds, parked, closures };
    const subscriptions = (['orders', 'refunds', 'parked', 'closures'] as const).map(key =>
      sources[key]?.count().$.subscribe(count => setCounts(current => ({ ...current, [key]: count }))));
    return () => subscriptions.forEach(subscription => subscription?.unsubscribe());
  }, [orders, refunds, parked, closures]);
  // On demand: the panel opens only when the merchant asks, and again when the catalogue's first pull lands (catalogueSynced; a re-download resets it). Variants live inside their product's document, so have no size.
  const [measureRun, setMeasureRun] = useState(0);
  const [sizes, setSizes] = useState<Record<'products' | 'orders' | 'refunds' | 'parked' | 'closures', number | null | undefined>>({ products: undefined, orders: undefined, refunds: undefined, parked: undefined, closures: undefined });
  useEffect(() => {
    setSizes({ products: undefined, orders: undefined, refunds: undefined, parked: undefined, closures: undefined });
    const controller = new AbortController();
    const sources = { products, orders, refunds, parked, closures };
    void (async () => {
      for (const key of ['products', 'orders', 'refunds', 'parked', 'closures'] as const) {
        const collection = sources[key];
        let size: number | null = null;
        if (collection) try { size = (await measureCollectionBytes(collection, { signal: controller.signal })).bytes; }
        catch (error) { if (!controller.signal.aborted) console.warn(`Failed to measure ${key}`, error); }
        if (controller.signal.aborted) return;
        setSizes(current => ({ ...current, [key]: size }));
      }
    })();
    return () => controller.abort();
  }, [products, orders, refunds, parked, closures, measureRun, catalogueSynced]);
  const [totals, setTotals] = useState<ServerTotals>({ products: null, variants: null, orders: null });
  useEffect(() => {
    let cancelled = false;
    void readServerTotals(sessionContext(session)).then(result => { if (!cancelled) setTotals(result); });
    return () => { cancelled = true; };
  }, [session]);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    void readStorageUsed(typeof navigator === 'undefined' ? undefined : navigator.storage).then(result => { if (!cancelled) setStorageUsed(result); });
    return () => { cancelled = true; };
  }, []);
  const blocked = redownloadBlocked(redownloading, totals.products);
  const rows = [
    { key: 'products', name: 'Products', note: 'the whole catalogue, kept in step with the store', count: productCount,
      server: totals.products, coverage: coveragePercent(productCount, totals.products) ?? (catalogueSynced ? 100 : 0) },
    // v2 13d's "↳ Variations": every variant on both sides, as Products counts every product.
    { key: 'variants', name: '↳ Variants', note: null, count: variantCount, server: totals.variants, coverage: coveragePercent(variantCount, totals.variants) },
    { key: 'orders', name: 'Orders', note: "this till's sales on the device · the store's orders on the server", count: counts.orders,
      server: totals.orders, coverage: coveragePercent(counts.orders, totals.orders) },
    { key: 'refunds', name: 'Refunds', note: 'refunds taken on this till', count: counts.refunds, server: null, coverage: null },
    { key: 'parked', name: 'Parked sales', note: 'carts parked on this till', count: counts.parked, server: null, coverage: null },
    { key: 'closures', name: 'Closures', note: "this register's Z reports", count: counts.closures, server: null, coverage: null },
  ];
  return (
    <VStack testID="store-health-panel" className="flex-1">
      <ScrollView contentContainerClassName="p-4">
        <Card>
          <CardHeader>
            <CardTitle>Store health</CardTitle>
            <CardDescription>Your store, on this device — sales keep working even if your server does not.</CardDescription>
          </CardHeader>
          <CardContent>
            <HStack className="flex-wrap border-b border-border pb-4" space="xl">
              <VStack>
                <Text testID="store-health-ready" className={`text-lg font-semibold ${ready.ready ? 'text-success' : 'text-warning'}`}>
                  {ready.ready ? '✓ Ready to sell' : 'Not ready to sell'}
                </Text>
                <Text testID="store-health-ready-detail" className="text-xs text-muted-foreground">
                  {ready.ready ? 'catalogue & register on this device' : ready.reason}
                </Text>
              </VStack>
              <VStack>
                <Text testID="store-health-records" className="text-lg font-semibold">{recordsOnDevice([productCount, ...Object.values(counts)])}</Text>
                <Text className="text-xs text-muted-foreground">records on this device</Text>
              </VStack>
              {storageUsed !== null ? <VStack>
                <Text testID="store-health-storage" className="text-lg font-semibold">{formatStorageUsed(storageUsed)}</Text>
                <Text className="text-xs text-muted-foreground">storage used</Text>
              </VStack> : null}
              <VStack>
                <Text testID="store-health-waiting" className={`text-lg font-semibold ${waiting > 0 ? 'text-destructive' : ''}`}>{waiting}</Text>
                <Text className="text-xs text-muted-foreground">changes waiting to send</Text>
              </VStack>
            </HStack>
            {attention.length > 0 ? (
              <VStack testID="store-health-attention" className="mt-4 rounded-md border border-destructive bg-destructive/10 p-4" space="sm">
                <Text testID="store-health-attention-title" className="font-semibold">
                  {`${attention.length} ${attention.length === 1 ? 'record needs' : 'records need'} attention`}
                </Text>
                {attention.map(({ order, reason, retry }) => (
                  <HStack key={order.id} testID={`store-health-attention-${order.id}`} className="flex-wrap items-center" space="sm">
                    <Text className="flex-1">{`Order ${orderReference(order)} · ${formatMoney({ amount: order.totalMinor, currency: order.currency })} — ${reason}`}</Text>
                    <Button testID={`store-health-attention-open-${order.id}`} variant="ghost" size="sm" onPress={() => onOpen(order)}><Text>Fix record</Text></Button>
                    {retry ? <Button testID={`store-health-attention-retry-${order.id}`} size="sm" onPress={() => void onRetry([order.id])}><Text>Retry</Text></Button> : null}
                  </HStack>
                ))}
                {/* v2's View log ›: once per callout, whatever the rows; it opens Settings › Sync log. */}
                <Button testID="store-health-attention-view-log" variant="link" size="sm" className="self-start px-0" onPress={onViewLog}>
                  <Text>View log ›</Text>
                </Button>
              </VStack>
            ) : null}
            <Table className="mt-4">
              <TableHeader><TableRow>
                <TableHead><Text>Collection</Text></TableHead>
                <TableHead className="w-28"><Text className="text-right">On device</Text></TableHead>
                <TableHead className="w-28"><Text className="text-right">On server</Text></TableHead>
                <TableHead className="w-28"><Text className="text-right">Coverage</Text></TableHead>
                <TableHead className="w-24"><Text className="text-right">Size</Text></TableHead>
              </TableRow></TableHeader>
              <TableBody>{rows.map(row => <View key={row.key} testID={`store-health-row-${row.key}`}><TableRow>
                <TableCell><VStack space="none">
                  <HStack space="sm" className="items-center">
                    <Text className="font-medium">{row.name}</Text>
                    {row.key === 'orders' && attention.length > 0 ? <Badge testID="store-health-stuck-orders" variant="destructive" label={`${attention.length} stuck`} /> : null}
                  </HStack>
                  {row.note ? <Text className="text-xs text-muted-foreground">{row.note}</Text> : null}
                  {row.key === 'products' ? <Button testID="store-health-redownload" variant="link" size="sm" className="self-start px-0"
                    disabled={blocked !== null} onPress={() => setConfirming(true)}>
                    <Text>{redownloading ? 'Re-downloading…' : 'Clear & re-download'}</Text>
                  </Button> : null}
                  {row.key === 'products' && !redownloading && blocked !== null
                    ? <Text testID="store-health-redownload-blocked" className="text-xs text-muted-foreground">{blocked}</Text> : null}
                </VStack></TableCell>
                <TableCell className="w-28"><Text testID={`store-health-count-${row.key}`} className="text-right">{row.count ?? '—'}</Text></TableCell>
                <TableCell className="w-28"><Text testID={`store-health-server-${row.key}`} className="text-right text-muted-foreground">{row.server ?? '—'}</Text></TableCell>
                {/* TallyUI's Progress drops value from its Root, so aria-valuenow is passed itself. */}
                <TableCell className="w-28 items-end">{row.coverage === null
                  ? <Text className="text-muted-foreground">this till</Text>
                  : <Progress testID={`store-health-coverage-${row.key}`} value={row.coverage} aria-valuenow={row.coverage} className="h-2 w-20" />}</TableCell>
                <TableCell className="w-24"><Text testID={`store-health-size-${row.key}`} className={`text-right${row.key === 'variants' ? ' text-muted-foreground' : ''}`}>
                  {row.key === 'variants' ? 'in Products' : formatCollectionSize(sizes[row.key as keyof typeof sizes])}</Text></TableCell>
              </TableRow></View>)}</TableBody>
            </Table>
            <Button testID="store-health-check-now" variant="outline" className="mt-4 self-start" disabled={checking} onPress={() => void checkNow()}>
              <Text>{checking ? 'Checking…' : 'Check everything now'}</Text>
            </Button>
          </CardContent>
        </Card>
        <View className="mt-4"><SyncCadenceCard /></View>
      </ScrollView>
      <Dialog open={confirming} onOpenChange={open => (open ? setConfirming(true) : closeConfirm())}>
        <DialogContent testID="store-health-redownload-confirm" className="max-w-md">
          <DialogTitle>Clear and re-download the products?</DialogTitle>
          <DialogDescription>{redownloadSummary(productCount)}</DialogDescription>
          <Text className="text-sm text-muted-foreground">
            {"Nothing changes on your store. This till's sales, refunds, parked carts and closures stay on this device. Products can't be scanned or found until the download finishes."}
          </Text>
          <HStack space="sm" className="justify-end">
            <Button testID="store-health-redownload-cancel" variant="outline" onPress={closeConfirm}><Text>Cancel</Text></Button>
            <Button testID="store-health-redownload-yes" variant="destructive" disabled={checkingStore} onPress={() => void confirmYes()}>
              <Text>{checkingStore ? 'Checking the store…' : 'Clear & re-download'}</Text>
            </Button>
          </HStack>
        </DialogContent>
      </Dialog>
    </VStack>
  );
}
