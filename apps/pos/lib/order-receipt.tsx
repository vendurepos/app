import { useState, type JSX } from 'react';
import { Platform } from 'react-native';
import { Button, Text, VStack } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import type { ServerCapabilities, SyncContext } from '@tallyui/core';
import { CurrencyProvider } from '@tallyui/pos';
import { canEmailReceipt } from './receipt-email';
import { EmailReceiptAction, ReceiptEmailPanel, receiptEmailDefault, useReceiptEmailToggle } from './receipt-email-action';
import { ReceiptPrintSheet } from './receipt-print-sheet';
import { useReceiptPrinter } from './receipt-printer';
import { ReceiptView } from './receipt-view';
import { storedReceiptData } from './stored-receipt';

/**
 * A stored order's receipt, reprinted from the order sheet: the live receipt's layout, built from the order the store holds.
 * Email receipt is offered for a till's order only: the route refuses any other with 409 not_till_order.
 */
export function OrderReceipt({ order, store, pricesIncludeTax, onBack, capabilities, context }: {
  order: VendureOrder; store: string; pricesIncludeTax: boolean; onBack(): void;
  capabilities?: ServerCapabilities; context?: SyncContext;
}): JSX.Element {
  const receipt = storedReceiptData(order, { storeName: store, pricesIncludeTax });
  const direct = useReceiptPrinter();
  const email = useReceiptEmailToggle();
  const emailTo = canEmailReceipt(capabilities) && context !== undefined && order.code && order.customFields?.tallyClientOrderId
    ? context : null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const view = {
    receipt,
    orderLine: `Order ${receipt.header.orderNumber} · ${new Date(receipt.header.date).toLocaleString()}`,
    customer: receipt.header.customer,
    lineDiscountLabel: (i: number, j: number) => receipt.lineItems[i].displayDiscounts[j].label,
  };
  // The orders panel sits outside the sale's CurrencyProvider; the order's own currency formats its money, as the live receipt's does.
  return (
    <CurrencyProvider currencyCode={receipt.currency}>
      <ReceiptView {...view} testID="order-receipt"
        actions={(
          <>
            {/* The print sheet (a direct printer or the browser's print dialog); native has no print path yet, so no button there. */}
            {Platform.OS === 'web' ? (
              <Button testID="order-receipt-print" variant="secondary" disabled={direct.busy} onPress={() => setSheetOpen(true)}>
                <Text>Print receipt</Text>
              </Button>
            ) : null}
            {direct.status?.failed ? (
              <Button testID="order-receipt-print-dialog" variant="secondary" onPress={() => window.print()}>
                <Text>Print with the dialog</Text>
              </Button>
            ) : null}
            {emailTo ? <EmailReceiptAction testID="order-receipt-email" open={email.open} onToggle={email.toggle} /> : null}
            <Button testID="order-receipt-back" className="flex-1" onPress={onBack}>
              <Text>Back to order</Text>
            </Button>
          </>
        )} />
      {direct.status ? (
        <VStack dataSet={{ print: 'hide' }} space="none" className="px-3 pb-3">
          <Text testID="order-receipt-print-status">{direct.status.text}</Text>
        </VStack>
      ) : null}
      {emailTo && email.open ? (
        <ReceiptEmailPanel testID="order-receipt-email-panel" context={emailTo} orderCode={order.code}
          defaultAddress={receiptEmailDefault(order.customer)} sendKey={email.sendKey} />
      ) : null}
      <ReceiptPrintSheet open={sheetOpen} onOpenChange={setSheetOpen}
        onPrint={(target) => { if (target === null) window.print(); else void direct.print(receipt, target); }}>
        {/* The sheet draws through the root PortalHost, outside the CurrencyProvider above. */}
        <CurrencyProvider currencyCode={receipt.currency}>
          <ReceiptView {...view} testID="order-receipt-preview" />
        </CurrencyProvider>
      </ReceiptPrintSheet>
    </CurrencyProvider>
  );
}
