import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SalesCards, SalesFiltersBar, VStack } from '@tallyui/components';
import { watchFresh, type PosOrder, type PosRefund, type PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillHourly, tillSalesFigures } from './till-reports';
import { TillSalesHero } from './till-sales-hero';

export function ReportsPanel({ orders, refunds, currency, timezone, drawer }: {
  orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; drawer?: ReactNode;
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
  const hourly = useMemo(() => tillHourly({ orders: orderList, filters, timezone }), [orderList, filters, timezone]);
  return (
    <VStack testID="reports-panel" className="flex-1">
      <ScrollView contentContainerClassName="p-4">
        <View testID="sales-room" className="gap-4">
          {drawer}
          <SalesFiltersBar filters={filters} onFiltersChange={setFilters} timezone={timezone}
            statusOptions={REPORT_STATUS_OPTIONS} {...reportOptions(orderList)} />
          <TillSalesHero figures={figures} filters={filters} onFiltersChange={setFilters} currency={currency} hourly={hourly} />
          <SalesCards figures={figures} currency={currency} />
        </View>
      </ScrollView>
    </VStack>
  );
}
