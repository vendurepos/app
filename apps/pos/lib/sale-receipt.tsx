import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Button, discountLabel, orderReference, Text, VStack } from '@tallyui/components';
import type { ServerCapabilities, SyncContext } from '@tallyui/core';
import { buildReceiptData, CurrencyProvider, type PosOrder, type useSale } from '@tallyui/pos';
import type { RxCollection } from 'rxdb';
import { loadAutoPrint } from './auto-print-setting';
import { canEmailReceipt } from './receipt-email';
import { EmailReceiptAction, ReceiptEmailPanel, receiptEmailDefault, useReceiptEmailToggle, useStoredOrderCode } from './receipt-email-action';
import { ReceiptPrintSheet } from './receipt-print-sheet';
import { printFailedAfterClose, useReceiptPrinter } from './receipt-printer';
import { ReceiptView } from './receipt-view';

/**
 * The completed sale's receipt, from the order as finalized and stored; New sale starts the next one.
 * `onPrintFailedAfterClose` hears of a direct print (auto or Print receipt) that failed once this receipt had gone;
 * while it shows, its own status line says so. Email receipt shows once the store has the order (its code is in `orders`).
 */
export function SaleReceipt({ sale, store, cashier, registerId, till, onPrintFailedAfterClose, orders, capabilities, context }: {
  sale: ReturnType<typeof useSale>; store: string; cashier: string; registerId: string; till?: boolean;
  onPrintFailedAfterClose?(text: string): void;
  orders?: RxCollection<PosOrder> | null; capabilities?: ServerCapabilities; context?: SyncContext;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const printedFor = useRef<string | null>(null);
  const { stage } = sale;
  const receiptOrderId = stage.kind === 'receipt' ? stage.order.id : null;
  // The outbox keys the stored order by the PosOrder's own id; the sale order's id is only its `saleId`.
  const code = useStoredOrderCode(orders ?? null, stage.kind === 'receipt' ? stage.posOrder.id : null);
  const email = useReceiptEmailToggle();
  const receipt = useMemo(() => stage.kind === 'receipt'
    ? buildReceiptData(stage.order, { storeName: store, cashier, register: registerId }) : null, [stage, store, cashier, registerId]);
  const { printer, busy, status, print: printDirect } = useReceiptPrinter();
  // Only a direct print fails; the till's notice offers Orders, not the dialog button that went with the receipt.
  const afterPrint = useCallback((failure: string | null, name: string) => {
    if (failure !== null && !mounted.current) onPrintFailedAfterClose?.(printFailedAfterClose(name));
  }, [onPrintFailedAfterClose]);
  const [sheetOpen, setSheetOpen] = useState(false);
  // A direct printer takes the receipt (resolving to its failure line, or null); without one, the browser's print dialog does.
  const print = useMemo(() => {
    if (Platform.OS !== 'web' || receipt === null) return undefined;
    if (printer === null) return () => { window.print(); return Promise.resolve(null); };
    return () => printDirect(receipt);
  }, [receipt, printer, printDirect]);
  useEffect(() => {
    if (receiptOrderId === null || receiptOrderId === printedFor.current) return;
    printedFor.current = receiptOrderId;
    if (loadAutoPrint()) void print?.().then((failure) => { if (printer) afterPrint(failure, printer.name); });
  }, [receiptOrderId, print, afterPrint, printer]);
  if (stage.kind !== 'receipt' || receipt === null) return null;
  const { order, posOrder } = stage;
  const emailTo = canEmailReceipt(capabilities) && code !== null && context !== undefined ? { code, context } : null;
  const view = {
    receipt,
    orderLine: `Order ${orderReference(posOrder)} · ${till ? `Till: ${receipt.header.cashier}` : receipt.header.cashier}`,
    customer: order.customer?.name,
    lineDiscountLabel: (i: number, j: number) => `${discountLabel(order.lineItems[i].discounts[j], receipt.currency)} off`,
  };
  return (
    <>
      <ReceiptView {...view} testID="receipt"
        actions={(
          <>
            {/* The print sheet (a direct printer or the browser's print dialog); native has no print path yet, so no button there. */}
            {print ? (
              <Button testID="receipt-print" variant="secondary" disabled={busy} onPress={() => setSheetOpen(true)}>
                <Text>Print receipt</Text>
              </Button>
            ) : null}
            {status?.failed ? (
              <Button testID="receipt-print-dialog" variant="secondary" onPress={() => window.print()}>
                <Text>Print with the dialog</Text>
              </Button>
            ) : null}
            {emailTo ? <EmailReceiptAction testID="receipt-email" open={email.open} onToggle={email.toggle} /> : null}
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
      {emailTo && email.open ? (
        <ReceiptEmailPanel testID="receipt-email-panel" context={emailTo.context} orderCode={emailTo.code}
          defaultAddress={receiptEmailDefault(order.customer)} sendKey={email.sendKey} />
      ) : null}
      <ReceiptPrintSheet open={sheetOpen} onOpenChange={setSheetOpen} onPrint={(target) => {
        if (target === null) window.print();
        else void printDirect(receipt, target).then((failure) => afterPrint(failure, target.name));
      }}>
        {/* The sheet draws through the root PortalHost, outside the sale's CurrencyProvider. */}
        <CurrencyProvider currencyCode={receipt.currency}>
          <ReceiptView {...view} testID="receipt-preview" />
        </CurrencyProvider>
      </ReceiptPrintSheet>
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
