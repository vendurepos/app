import { Fragment, useEffect, useState, type JSX, type ReactNode } from 'react';
import { Button, HStack, OrderDetail, Text, VStack, type OrderHistoryRow } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import type { PosOrder } from '@tallyui/pos';
import { ORDER_LOADING_TEXT, orderCustomerName, orderHeaderMeta, orderDetailTarget, orderDetailView, useOrderDetail } from './order-detail';
import { NOTE_LABEL, STAFF_NOTE_LABEL, useOrderNotes } from './order-notes';
import { fetchRegisters, type ListedRegister } from './register-choice';
import type { Session } from './session';
import { attentionReason, canSendAgain, canSendWithoutAddress } from './store-health';

/** One order's read-only detail from the store, opened from the Orders panel. */
export function OrderSheet({ session, row, timezone, onClose, onRetry, footer, receipt }: {
  session: Session; row: PosOrder | OrderHistoryRow; timezone: string; onClose(): void;
  /** The till's retry (retryOrders): a refused sale Retry can fix gets a primary Retry (tax_zone_mismatch: Send without the address), and the sheet closes once it is sent. */
  onRetry?: (orderIds: string[]) => Promise<number>;
  /** Rendered in OrderDetail's footerSlot once the order is loaded; reload re-reads it from the store. */
  footer?: (order: VendureOrder, reload: () => void) => ReactNode;
  /** The loaded order's receipt, shown in place of the detail after Receipt; back returns to the detail. */
  receipt?: (order: VendureOrder, back: () => void) => ReactNode;
}): JSX.Element {
  const target = orderDetailTarget(row);
  const { order, notice, loading, reload } = useOrderDetail(session, 'orderId' in target ? target.orderId : null);
  const notes = useOrderNotes(session, 'orderId' in target ? target.orderId : null);
  const [showReceipt, setShowReceipt] = useState(false);
  const view = order ? orderDetailView(order) : null;
  const refused = 'syncStatus' in row && row.syncStatus === 'rejected' ? row : null;
  const resend = refused && onRetry ? canSendAgain(refused) ? 'send-again' : canSendWithoutAddress(refused) ? 'send-without-address' : null : null;
  const [sending, setSending] = useState(false);
  const [registers, setRegisters] = useState<ListedRegister[]>([]);
  useEffect(() => {
    let live = true;
    void fetchRegisters(session).then(listed => { if (live) setRegisters(listed); }, () => {});
    return () => { live = false; };
  }, [session]);
  return (
    <VStack testID="order-sheet" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="border-b border-border px-4 py-2">
        <Button testID="order-sheet-close" variant="secondary" size="sm" onPress={onClose}>
          <Text>Back to orders</Text>
        </Button>
        {order && receipt && !showReceipt ? (
          <Button testID="order-sheet-receipt" variant="secondary" size="sm" onPress={() => setShowReceipt(true)}>
            <Text>Receipt</Text>
          </Button>
        ) : null}
      </HStack>
      {'note' in target ? (
        <Text testID="order-sheet-note" className="px-4 py-2 text-sm text-muted-foreground">{target.note}</Text>
      ) : null}
      {refused ? (
        <HStack className="items-center border-b border-destructive bg-destructive/10 px-4 py-3" space="sm">
          <Text testID="order-sheet-refused" className="flex-1 font-semibold">{attentionReason(refused)}</Text>
          {onRetry && resend ? (
            <Button testID={`order-sheet-${resend}`} disabled={sending} onPress={() => { setSending(true); void onRetry([refused.id]).then(onClose, () => setSending(false)); }}>
              <Text>{resend === 'send-again' ? 'Retry' : 'Send without the address'}</Text>
            </Button>
          ) : null}
        </HStack>
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
      {order && receipt && showReceipt ? receipt(order, () => setShowReceipt(false)) : order && view ? (
        <OrderDetail testID="order-sheet-detail" orderNumber={view.orderNumber} status={view.status} lineItems={view.lineItems}
          subtotal={view.subtotal} tax={view.tax} total={view.total}
          customerSlot={(
            <VStack>
              <Text testID="order-sheet-customer" className="font-medium">{orderCustomerName(order)}</Text>
              <Text testID="order-sheet-meta" className="text-sm text-muted-foreground">{orderHeaderMeta(order, { timezone, now: new Date(), registers })}</Text>
              <Text testID="order-sheet-state" className="text-sm text-muted-foreground">{view.state}</Text>
              {view.fulfilments.length > 0 ? (
                <VStack testID="order-sheet-fulfilments" className="mt-2">
                  {view.fulfilments.map(f => (
                    <Text key={f.id} testID={`order-sheet-fulfilment-${f.id}`} className="text-sm">
                      <Text className="font-semibold">Fulfilment: </Text>{f.text}
                    </Text>
                  ))}
                </VStack>
              ) : null}
              {/* Never printed or on a receipt: notes stay on this sheet (Front desk ruling, 2026-11-21). */}
              {notes.length > 0 ? (
                <VStack testID="order-sheet-notes" dataSet={{ print: 'hide' }} className="mt-2">
                  {notes.map(note => (
                    <Text key={note.id} testID={`order-sheet-order-note-${note.id}`} className="text-sm">
                      <Text className="font-semibold">{note.staff ? STAFF_NOTE_LABEL : NOTE_LABEL}: </Text>{note.text}
                    </Text>
                  ))}
                </VStack>
              ) : null}
            </VStack>
          )}
          paymentSlot={(
            <VStack>
              <Text className="font-semibold">Payment</Text>
              {view.payments.length === 0 ? <Text testID="order-sheet-no-payments">No payments yet</Text> : null}
              {view.payments.map(payment => (
                <Fragment key={payment.id}>
                  <Text testID={`order-sheet-payment-${payment.id}`}>{payment.text}</Text>
                  {payment.refunds.map(refund => (
                    <Text key={refund.id} testID={`order-sheet-refund-${refund.id}`}>{refund.text}</Text>
                  ))}
                </Fragment>
              ))}
              {([['total', 'Total', view.paymentTotals.total], ['paid', 'Paid', view.paymentTotals.paid],
                ['refunded', 'Refunded', view.paymentTotals.refunded], ['remaining', 'Remaining', view.paymentTotals.remaining]] as const)
                .map(([key, label, amount]) => amount === null ? null : (
                  <HStack key={key} testID={`order-sheet-payment-${key}`} className="justify-between">
                    <Text className={key === 'remaining' ? 'font-semibold' : undefined}>{label}</Text>
                    <Text className={key === 'remaining' ? 'font-semibold' : undefined}>{amount}</Text>
                  </HStack>
                ))}
            </VStack>
          )}
          footerSlot={footer?.(order, reload)} />
      ) : null}
    </VStack>
  );
}
