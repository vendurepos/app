import { useEffect, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, HStack, SalesRoom, Text, VStack } from '@tallyui/components';
import { watchFresh, type PosOrder, type PosRefund, type PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillSalesFigures } from './till-reports';

export function ReportsPanel({ orders, refunds, currency, timezone, onClose }: {
  orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; onClose(): void;
}) {
  const [orderList, setOrderList] = useState<PosOrder[]>([]);
  const [refundList, setRefundList] = useState<PosRefund[]>([]);
  const [filters, setFilters] = useState(() => initialSalesFilters(new Date(), timezone));
  useEffect(() => {
    setOrderList([]);
    if (!orders) return;
    const subscription = watchFresh(orders, { selector: {} }).subscribe(setOrderList);
    return () => subscription.unsubscribe();
  }, [orders]);
  useEffect(() => {
    setRefundList([]);
    if (!refunds) return;
    const subscription = watchFresh(refunds, { selector: {} }).subscribe(setRefundList);
    return () => subscription.unsubscribe();
  }, [refunds]);
  const figures = useMemo(() => tillSalesFigures({ orders: orderList, refunds: refundList, filters, timezone }), [orderList, refundList, filters, timezone]);
  return (
    <VStack testID="reports-panel" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="border-b border-border px-4 py-2">
        <Button testID="reports-close" variant="secondary" size="sm" onPress={onClose}>
          <Text>Back to sale</Text>
        </Button>
      </HStack>
      <ScrollView contentContainerClassName="p-4">
        <SalesRoom figures={figures} currency={currency} filters={filters} onFiltersChange={setFilters} timezone={timezone}
          statusOptions={REPORT_STATUS_OPTIONS} {...reportOptions(orderList)} />
      </ScrollView>
    </VStack>
  );
}
