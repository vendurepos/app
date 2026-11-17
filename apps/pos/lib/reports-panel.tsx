import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SalesCards, SalesFiltersBar, VStack } from '@tallyui/components';
import type { PosOrder, PosRefundCollection } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { initialSalesFilters, reportOptions, REPORT_STATUS_OPTIONS, tillHourly, tillOrderSpread, tillSalesFigures } from './till-reports';
import { TillSalesHero } from './till-sales-hero';
import { useFreshList } from './use-fresh-list';

export function ReportsPanel({ orders, refunds, currency, timezone, drawer }: {
  orders: RxCollection<PosOrder> | null; refunds: PosRefundCollection | null; currency: string; timezone: string; drawer?: ReactNode;
}) {
  const orderList = useFreshList(orders);
  const refundList = useFreshList(refunds);
  const [filters, setFilters] = useState(() => initialSalesFilters(new Date(), timezone));
  const figures = useMemo(() => tillSalesFigures({ orders: orderList, refunds: refundList, filters, timezone }), [orderList, refundList, filters, timezone]);
  const hourly = useMemo(() => tillHourly({ orders: orderList, filters, timezone }), [orderList, filters, timezone]);
  const spread = useMemo(() => tillOrderSpread({ orders: orderList, filters, timezone }), [orderList, filters, timezone]);
  return (
    <VStack testID="reports-panel" className="flex-1">
      <ScrollView contentContainerClassName="p-4">
        <View testID="sales-room" className="gap-4">
          {drawer}
          <SalesFiltersBar filters={filters} onFiltersChange={setFilters} timezone={timezone}
            statusOptions={REPORT_STATUS_OPTIONS} {...reportOptions(orderList)} />
          <TillSalesHero figures={figures} filters={filters} onFiltersChange={setFilters} currency={currency} hourly={hourly} spread={spread} />
          <SalesCards figures={figures} currency={currency} />
        </View>
      </ScrollView>
    </VStack>
  );
}
