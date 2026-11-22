import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { Button, discountLabel, orderReference, Text, VStack } from '@tallyui/components';
import { buildReceiptData, CurrencyProvider, type useSale } from '@tallyui/pos';
import { loadAutoPrint } from './auto-print-setting';
import { printFailedAfterClose, useReceiptPrinter } from './receipt-printer';
import { ReceiptView } from './receipt-view';

/**
 * The completed sale's receipt, from the order as finalized and stored; New sale starts the next one.
 * `onPrintFailedAfterClose` hears of a direct print (auto or Print receipt) that failed once this receipt had gone;
 * while it shows, its own status line says so.
 */
export function SaleReceipt({ sale, store, cashier, registerId, till, onPrintFailedAfterClose }: {
  sale: ReturnType<typeof useSale>; store: string; cashier: string; registerId: string; till?: boolean;
  onPrintFailedAfterClose?(text: string): void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const printedFor = useRef<string | null>(null);
  const { stage } = sale;
  const receiptOrderId = stage.kind === 'receipt' ? stage.order.id : null;
  const receipt = useMemo(() => stage.kind === 'receipt'
    ? buildReceiptData(stage.order, { storeName: store, cashier, register: registerId }) : null, [stage, store, cashier, registerId]);
  const { printer, busy, status, print: printDirect } = useReceiptPrinter();
  // Only a direct print fails; the till's notice offers Orders, not the dialog button that went with the receipt.
  const afterPrint = useCallback((failure: string | null) => {
    if (failure !== null && !mounted.current && printer !== null) onPrintFailedAfterClose?.(printFailedAfterClose(printer.name));
  }, [onPrintFailedAfterClose, printer]);
  // A direct printer takes the receipt (resolving to its failure line, or null); without one, the browser's print dialog does.
  const print = useMemo(() => {
    if (Platform.OS !== 'web' || receipt === null) return undefined;
    if (printer === null) return () => { window.print(); return Promise.resolve(null); };
    return () => printDirect(receipt);
  }, [receipt, printer, printDirect]);
  useEffect(() => {
    if (receiptOrderId === null || receiptOrderId === printedFor.current) return;
    printedFor.current = receiptOrderId;
    if (loadAutoPrint()) void print?.().then(afterPrint);
  }, [receiptOrderId, print, afterPrint]);
  if (stage.kind !== 'receipt' || receipt === null) return null;
  const { order, posOrder } = stage;
  return (
    <>
      <ReceiptView receipt={receipt} testID="receipt"
        orderLine={`Order ${orderReference(posOrder)} · ${till ? `Till: ${receipt.header.cashier}` : receipt.header.cashier}`}
        customer={order.customer?.name}
        lineDiscountLabel={(i, j) => `${discountLabel(order.lineItems[i].discounts[j], receipt.currency)} off`}
        actions={(
          <>
            {/* The direct printer or the browser's print dialog; native has no print path yet, so no button there. */}
            {print ? (
              <Button testID="receipt-print" variant="secondary" disabled={busy} onPress={() => void print().then(afterPrint)}>
                <Text>Print receipt</Text>
              </Button>
            ) : null}
            {status?.failed ? (
              <Button testID="receipt-print-dialog" variant="secondary" onPress={() => window.print()}>
                <Text>Print with the dialog</Text>
              </Button>
            ) : null}
            <Button testID="new-sale" className="flex-1" onPress={sale.newSale}>
              <Text>New sale</Text>
            </Button>
          </>
        )} />
      {status ? (
        <VStack dataSet={{ print: 'hide' }} space="none" className="px-3 pb-3">
          <Text testID="receipt-print-status">{status.text}</Text>
        </VStack>
      ) : null}
    </>
  );
}

/** The open sale as an unpaid bill (v2's Order details › Print, CHECKLIST 2.11b): read only, it changes nothing in the sale. */
export function SaleBill({ order, store }: { order: ReturnType<typeof useSale>['order']; store: string }) {
  const receipt = buildReceiptData(order, { storeName: store });
  return (
    <CurrencyProvider currencyCode={receipt.currency}>
      <ReceiptView receipt={receipt} testID="bill" bill customer={order.customer?.name}
        lineDiscountLabel={(i, j) => `${discountLabel(order.lineItems[i].discounts[j], receipt.currency)} off`} />
    </CurrencyProvider>
  );
}
