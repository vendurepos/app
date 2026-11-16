import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import {
  Button, HStack, OrderFilterBar, OrdersList, OrderStatusBadge, SearchInput,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text, VStack,
  type OrderFilterOption, type OrderHistoryRow,
} from '@tallyui/components';
import { searchVendureCustomers } from '@tallyui/connector-vendure';
import { formatMoney } from '@tallyui/core';
import { needsAttention, type OrderFilterValue, type OutboxState, type PosOrder } from '@tallyui/pos';
import {
  groupOrdersByDay, ORDER_SEARCH_DEBOUNCE_MS, ORDER_STATUS_OPTIONS, storeDayOf,
  toOrderTableRow, useOrderList, VENDURE_ORDER_FILTER_FIELDS, type OrderListQuery, type OrderTableRow,
} from './order-list';
import { sessionContext, type Session } from './session';

export type OrdersScope = 'store' | 'till';
export function OrdersPanel({ session, timezone, scope, onScopeChange, till, registerId, cashier, onOpen }: {
  session: Session; timezone: string;
  scope: OrdersScope; onScopeChange: (scope: OrdersScope) => void;
  till: { orders: PosOrder[]; onRetry: (orderIds: string[]) => Promise<number>; stuck: OutboxState['stuck'] };
  registerId: string; cashier: string;
  onOpen: (row: PosOrder | OrderHistoryRow) => void;
}): JSX.Element {
  const wide = useWindowDimensions().width >= 640;
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<OrderFilterValue>({});
  const query = useMemo<OrderListQuery>(() => ({ search, filters }), [search, filters]);
  const { orders, totalItems, notice, loading, loadMore, reload } = useOrderList(session, scope === 'store', query, timezone);
  const rows = useMemo(() => orders.map(order => toOrderTableRow(order, timezone)), [orders, timezone]);
  const groups = groupOrdersByDay(rows, storeDayOf(new Date().toISOString(), timezone));
  const attention = needsAttention(till.orders, { stuckCommandIds: till.stuck?.commandIds }).length;
  const [customers, setCustomers] = useState<OrderFilterOption[]>([]);
  const [pickedCustomer, setPickedCustomer] = useState<OrderFilterOption>();
  useEffect(() => {
    const picked = customers.find(option => option.value === filters.customerId);
    if (picked) setPickedCustomer(picked);
  }, [customers, filters.customerId]);
  const customerOptions = pickedCustomer?.value === filters.customerId && pickedCustomer
    && !customers.some(option => option.value === pickedCustomer.value) ? [...customers, pickedCustomer] : customers;
  const cashierOptions = useMemo(() => [...new Set([cashier, ...till.orders.map(order => order.cashierRef)]
    .filter((value): value is string => !!value))].sort().map(value => ({ value, label: value })), [cashier, till.orders]);
  const customerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const customerRequest = useRef(0);
  useEffect(() => () => { clearTimeout(customerTimer.current); customerRequest.current++; }, []);
  const onCustomerSearch = (text: string) => {
    clearTimeout(customerTimer.current);
    const request = ++customerRequest.current;
    if (!text.trim()) return;
    customerTimer.current = setTimeout(() => {
      void searchVendureCustomers(sessionContext(session), text, { limit: 10 }).then(results => {
        if (request === customerRequest.current) setCustomers(results.map(({ id, name }) => ({ value: id, label: name })));
      }).catch(() => { /* Keep the last options when the search fails. */ });
    }, ORDER_SEARCH_DEBOUNCE_MS);
  };
  return (
    <VStack className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button testID="orders-scope-store" size="sm" variant={scope === 'store' ? 'secondary' : 'ghost'}
          accessibilityState={{ selected: scope === 'store' }} onPress={() => onScopeChange('store')}>
          <Text>All orders</Text>
        </Button>
        <Button testID="orders-scope-till" size="sm" variant={scope === 'till' ? 'secondary' : 'ghost'}
          accessibilityState={{ selected: scope === 'till' }} onPress={() => onScopeChange('till')}>
          <Text>This till</Text>
          {attention > 0 ? <Text testID="orders-scope-till-count" className="text-destructive font-semibold">{attention}</Text> : null}
        </Button>
        {scope === 'store' ? <View className="min-w-[200px] flex-1">
          <SearchInput testID="orders-search" value={search} onChangeText={setSearch} placeholder="Order number or customer surname" />
        </View> : null}
      </HStack>
      {scope === 'till' ? <OrdersList orders={till.orders} onRetry={till.onRetry} stuck={till.stuck}
        formatDate={(iso) => new Date(iso).toLocaleString()} onOpen={onOpen} /> : <>
        <ScrollView horizontal dataSet={{ print: 'hide' }} className="border-b border-border px-4 py-2">
          <OrderFilterBar fields={VENDURE_ORDER_FILTER_FIELDS} value={filters} onChange={setFilters} initial={{}}
            timezone={timezone} onCustomerSearch={onCustomerSearch} options={{ status: ORDER_STATUS_OPTIONS,
              customer: customerOptions, cashier: cashierOptions, register: [{ value: registerId, label: 'This till' }] }} />
        </ScrollView>
        {notice ? (
          <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2" space="sm">
            <Text testID="orders-history-notice" className="flex-1 text-sm text-muted-foreground">{notice.text}</Text>
            {notice.retry ? (
              <Button testID="orders-history-retry" variant="secondary" size="sm" disabled={loading} onPress={reload}>
                <Text>Try again</Text>
              </Button>
            ) : null}
          </HStack>
        ) : null}
        <ScrollView className="flex-1">
          <Table>
            {wide ? <TableHeader><TableRow>
              {['Status', 'Order', 'Customer', 'Date', 'Cashier', 'Payment', 'Total'].map(label => (
                <TableHead key={label} className={label === 'Total' ? 'items-end' : undefined}><Text>{label}</Text></TableHead>
              ))}
            </TableRow></TableHeader> : null}
            <TableBody>
              {groups.map(group => <Fragment key={group.day}>
                <Text testID={`orders-day-${group.day}`} className="bg-muted/50 px-4 py-1.5 text-xs font-medium text-muted-foreground">{group.label}</Text>
                {group.rows.map(row => <OrderTableRowView key={row.id} row={row} wide={wide} timezone={timezone} onOpen={onOpen} />)}
              </Fragment>)}
            </TableBody>
          </Table>
          {loading && rows.length === 0 ? <Text testID="orders-loading" className="p-4">Loading orders…</Text> : null}
          {!loading && rows.length === 0 && !notice ? <Text testID="orders-store-empty" className="p-4 text-muted-foreground">
            {search || Object.values(filters).some(value => value !== undefined)
              ? 'No orders match this search and these filters.' : 'No orders on the store yet.'}
          </Text> : null}
          {rows.length > 0 ? <HStack className="items-center justify-between px-4 py-3">
            <Text testID="orders-count">{`Showing ${orders.length} of ${totalItems} orders`}</Text>
            {orders.length < totalItems ? <Button testID="orders-more" variant="secondary" size="sm" disabled={loading} onPress={loadMore}>
              <Text>Show more</Text>
            </Button> : null}
          </HStack> : null}
        </ScrollView>
      </>}
    </VStack>
  );
}

function OrderTableRowView({ row, wide, timezone, onOpen }: {
  row: OrderTableRow; wide: boolean; timezone: string; onOpen: (row: OrderHistoryRow) => void;
}) {
  const time = new Date(row.placedAt).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone: timezone === 'device' ? undefined : timezone,
  });
  const total = formatMoney({ amount: row.totalMinor, currency: row.currency });
  return (
    <Pressable testID={`orders-row-${row.id}`} accessibilityRole="button" accessibilityLabel={`Order ${row.code}`} onPress={() => onOpen(row.history)}>
      <TableRow>
        {wide ? <>
          <TableCell><OrderStatusBadge status={row.status} /></TableCell>
          <TableCell><Text className="font-medium">{row.code}</Text></TableCell>
          <TableCell><Text className={row.customer === null ? 'text-muted-foreground' : undefined}>{row.customer ?? 'Guest'}</Text></TableCell>
          <TableCell><Text>{time}</Text></TableCell>
          <TableCell><Text>{row.cashierRef ?? ''}</Text></TableCell>
          <TableCell><Text>{row.paymentMethods}</Text></TableCell>
          <TableCell><Text className="text-right tabular-nums">{total}</Text></TableCell>
        </> : <TableCell className="gap-2">
          <HStack className="justify-between"><Text className="font-medium">{row.code}</Text><Text className="tabular-nums">{total}</Text></HStack>
          <HStack className="items-center gap-2"><OrderStatusBadge status={row.status} />
            <Text className="text-muted-foreground">{`${row.customer ?? 'Guest'} · ${time}`}</Text>
          </HStack>
        </TableCell>}
      </TableRow>
    </Pressable>
  );
}
