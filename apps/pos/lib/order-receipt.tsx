import type { JSX } from 'react';
import { Platform } from 'react-native';
import { Button, Text, VStack } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import { CurrencyProvider } from '@tallyui/pos';
import { useReceiptPrinter } from './receipt-printer';
import { ReceiptView } from './receipt-view';
import { storedReceiptData } from './stored-receipt';

/** A stored order's receipt, reprinted from the order sheet: the live receipt's layout, built from the order the store holds. */
export function OrderReceipt({ order, store, pricesIncludeTax, onBack }: {
  order: VendureOrder; store: string; pricesIncludeTax: boolean; onBack(): void;
}): JSX.Element {
  const receipt = storedReceiptData(order, { storeName: store, pricesIncludeTax });
  // No money format for the printer: the CurrencyProvider below sets no locale or format, so its formatter and the
  // transport's default (formatMoney for the receipt's currency) print the same figures.
  const direct = useReceiptPrinter();
  // The orders panel sits outside the sale's CurrencyProvider; the order's own currency formats its money, as the live receipt's does.
  return (
    <CurrencyProvider currencyCode={receipt.currency}>
      <ReceiptView receipt={receipt} testID="order-receipt"
        orderLine={`Order ${receipt.header.orderNumber} · ${new Date(receipt.header.date).toLocaleString()}`}
        customer={receipt.header.customer}
        lineDiscountLabel={(i, j) => receipt.lineItems[i].displayDiscounts[j].label}
        actions={(
          <>
            {/* The direct printer or the browser's print dialog; native has no print path yet, so no button there. */}
            {Platform.OS === 'web' ? (
              <Button testID="order-receipt-print" variant="secondary" disabled={direct.busy}
                onPress={direct.printer ? () => void direct.print(receipt) : () => window.print()}>
                <Text>Print receipt</Text>
              </Button>
            ) : null}
            {direct.status?.failed ? (
              <Button testID="order-receipt-print-dialog" variant="secondary" onPress={() => window.print()}>
                <Text>Print with the dialog</Text>
              </Button>
            ) : null}
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
    </CurrencyProvider>
  );
}
