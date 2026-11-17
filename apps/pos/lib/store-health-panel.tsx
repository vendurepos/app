import { useEffect, useState, type JSX } from 'react';
import { ScrollView, View } from 'react-native';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, HStack, Progress, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text, VStack,
} from '@tallyui/components';
import type { RxCollection } from 'rxdb';
import { recordsOnDevice, type ReadyToSell } from './store-health';

export function StoreHealthPanel({ ready, waiting, productCount, catalogueSynced, collections }: {
  ready: ReadyToSell; waiting: number; productCount: number; catalogueSynced: boolean;
  collections: { orders: RxCollection | null; refunds: RxCollection | null; parked: RxCollection | null; closures: RxCollection | null };
}): JSX.Element {
  const { orders, refunds, parked, closures } = collections;
  const [counts, setCounts] = useState<Record<'orders' | 'refunds' | 'parked' | 'closures', number | null>>({ orders: null, refunds: null, parked: null, closures: null });
  useEffect(() => {
    setCounts({ orders: null, refunds: null, parked: null, closures: null });
    const sources = { orders, refunds, parked, closures };
    const subscriptions = (['orders', 'refunds', 'parked', 'closures'] as const).map(key =>
      sources[key]?.count().$.subscribe(count => setCounts(current => ({ ...current, [key]: count }))));
    return () => subscriptions.forEach(subscription => subscription?.unsubscribe());
  }, [orders, refunds, parked, closures]);
  const rows = [
    { key: 'products', name: 'Products', note: 'the whole catalogue, kept in step with the store', count: productCount },
    { key: 'orders', name: 'Orders', note: 'sales taken on this till', count: counts.orders },
    { key: 'refunds', name: 'Refunds', note: 'refunds taken on this till', count: counts.refunds },
    { key: 'parked', name: 'Parked sales', note: 'carts parked on this till', count: counts.parked },
    { key: 'closures', name: 'Closures', note: "this register's Z reports", count: counts.closures },
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
              <VStack>
                <Text testID="store-health-waiting" className={`text-lg font-semibold ${waiting > 0 ? 'text-destructive' : ''}`}>{waiting}</Text>
                <Text className="text-xs text-muted-foreground">changes waiting to send</Text>
              </VStack>
            </HStack>
            <Table className="mt-4">
              <TableHeader><TableRow>
                <TableHead><Text>Collection</Text></TableHead>
                <TableHead className="w-28"><Text className="text-right">On device</Text></TableHead>
                <TableHead className="w-28"><Text className="text-right">Coverage</Text></TableHead>
              </TableRow></TableHeader>
              <TableBody>{rows.map(row => <View key={row.key} testID={`store-health-row-${row.key}`}><TableRow>
                <TableCell><VStack space="none">
                  <Text className="font-medium">{row.name}</Text>
                  <Text className="text-xs text-muted-foreground">{row.note}</Text>
                </VStack></TableCell>
                <TableCell className="w-28"><Text testID={`store-health-count-${row.key}`} className="text-right">{row.count ?? '—'}</Text></TableCell>
                <TableCell className="w-28 items-end">{row.key === 'products'
                  ? <Progress value={catalogueSynced ? 100 : 0} className="h-2 w-20" />
                  : <Text className="text-muted-foreground">this till</Text>}</TableCell>
              </TableRow></View>)}</TableBody>
            </Table>
          </CardContent>
        </Card>
      </ScrollView>
    </VStack>
  );
}
