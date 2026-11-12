import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Button, discountLabel, orderReference, Text } from '@tallyui/components';
import { buildReceiptData, type useSale } from '@tallyui/pos';
import { loadAutoPrint } from './auto-print-setting';
import { ReceiptView } from './receipt-view';

/** The completed sale's receipt, from the order as finalized and stored; New sale starts the next one. */
export function SaleReceipt({ sale, store, cashier, registerId, till }: {
  sale: ReturnType<typeof useSale>; store: string; cashier: string; registerId: string; till?: boolean;
}) {
  const printedFor = useRef<string | null>(null);
  const receiptOrderId = sale.stage.kind === 'receipt' ? sale.stage.order.id : null;
  useEffect(() => {
    if (receiptOrderId === null || receiptOrderId === printedFor.current) return;
    printedFor.current = receiptOrderId;
    if (Platform.OS === 'web' && loadAutoPrint()) window.print();
  }, [receiptOrderId]);
  if (sale.stage.kind !== 'receipt') return null;
  const { order, posOrder } = sale.stage;
  const receipt = buildReceiptData(order, { storeName: store, cashier, register: registerId });
  return (
    <ReceiptView receipt={receipt} testID="receipt"
      orderLine={`Order ${orderReference(posOrder)} · ${till ? `Till: ${receipt.header.cashier}` : receipt.header.cashier}`}
      customer={order.customer?.name}
      lineDiscountLabel={(i, j) => `${discountLabel(order.lineItems[i].discounts[j], receipt.currency)} off`}
      actions={(
        <>
          {/* The browser's print dialog; native has no print path yet, so no button there. */}
          {Platform.OS === 'web' ? (
            <Button testID="receipt-print" variant="secondary" onPress={() => window.print()}>
              <Text>Print receipt</Text>
            </Button>
          ) : null}
          <Button testID="new-sale" className="flex-1" onPress={sale.newSale}>
            <Text>New sale</Text>
          </Button>
        </>
      )} />
  );
}
