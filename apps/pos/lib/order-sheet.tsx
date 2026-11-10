import { Fragment, type JSX, type ReactNode } from 'react';
import { Button, HStack, OrderDetail, Text, VStack, type OrderHistoryRow } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import type { PosOrder } from '@tallyui/pos';
import { ORDER_LOADING_TEXT, orderDetailTarget, orderDetailView, useOrderDetail } from './order-detail';
import type { Session } from './session';

/** One order's read-only detail from the store, opened from the Orders panel. */
export function OrderSheet({ session, row, onClose, footer }: {
  session: Session; row: PosOrder | OrderHistoryRow; onClose(): void;
  /** Rendered in OrderDetail's footerSlot once the order is loaded; reload re-reads it from the store. */
  footer?: (order: VendureOrder, reload: () => void) => ReactNode;
}): JSX.Element {
  const target = orderDetailTarget(row);
  const { order, notice, loading, reload } = useOrderDetail(session, 'orderId' in target ? target.orderId : null);
  const view = order ? orderDetailView(order) : null;
  return (
    <VStack testID="order-sheet" className="flex-1">
      <HStack className="border-b border-border px-4 py-2">
        <Button testID="order-sheet-close" variant="secondary" size="sm" onPress={onClose}>
          <Text>Back to orders</Text>
        </Button>
      </HStack>
      {'note' in target ? (
        <Text testID="order-sheet-note" className="px-4 py-2 text-sm text-muted-foreground">{target.note}</Text>
      ) : null}
      {loading && !order ? (
        <Text testID="order-sheet-loading" className="px-4 py-2 text-sm text-muted-foreground">{ORDER_LOADING_TEXT}</Text>
      ) : null}
      {notice ? (
        <HStack className="items-center border-b border-border px-4 py-2" space="sm">
          <Text testID="order-sheet-notice" className="flex-1 text-sm text-muted-foreground">{notice.text}</Text>
          {notice.retry ? (
            <Button testID="order-sheet-retry" variant="secondary" size="sm" disabled={loading} onPress={reload}>
              <Text>Try again</Text>
            </Button>
          ) : null}
        </HStack>
      ) : null}
      {order && view ? (
        <OrderDetail testID="order-sheet-detail" orderNumber={view.orderNumber} status={view.status} lineItems={view.lineItems}
          subtotal={view.subtotal} tax={view.tax} total={view.total}
          paymentSlot={(
            <VStack>
              {view.payments.map(payment => (
                <Fragment key={payment.id}>
                  <Text testID={`order-sheet-payment-${payment.id}`}>{payment.text}</Text>
                  {payment.refunds.map(refund => (
                    <Text key={refund.id} testID={`order-sheet-refund-${refund.id}`}>{refund.text}</Text>
                  ))}
                </Fragment>
              ))}
            </VStack>
          )}
          footerSlot={footer?.(order, reload)} />
      ) : null}
    </VStack>
  );
}
