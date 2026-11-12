import type { JSX } from 'react';
import { Platform } from 'react-native';
import { Button, Text } from '@tallyui/components';
import type { VendureOrder } from '@tallyui/connector-vendure';
import { CurrencyProvider } from '@tallyui/pos';
import { ReceiptView } from './receipt-view';
import { storedReceiptData } from './stored-receipt';

/** A stored order's receipt, reprinted from the order sheet: the live receipt's layout, built from the order the store holds. */
export function OrderReceipt({ order, store, pricesIncludeTax, onBack }: {
  order: VendureOrder; store: string; pricesIncludeTax: boolean; onBack(): void;
}): JSX.Element {
  const receipt = storedReceiptData(order, { storeName: store, pricesIncludeTax });
  // The orders panel sits outside the sale's CurrencyProvider; the order's own currency formats its money, as the live receipt's does.
  return (
    <CurrencyProvider currencyCode={receipt.currency}>
      <ReceiptView receipt={receipt} testID="order-receipt"
        orderLine={`Order ${receipt.header.orderNumber} · ${new Date(receipt.header.date).toLocaleString()}`}
        customer={receipt.header.customer}
        lineDiscountLabel={(i, j) => receipt.lineItems[i].displayDiscounts[j].label}
        actions={(
          <>
            {/* The browser's print dialog; native has no print path yet, so no button there. */}
            {Platform.OS === 'web' ? (
              <Button testID="order-receipt-print" variant="secondary" onPress={() => window.print()}>
                <Text>Print receipt</Text>
              </Button>
            ) : null}
            <Button testID="order-receipt-back" className="flex-1" onPress={onBack}>
              <Text>Back to order</Text>
            </Button>
          </>
        )} />
    </CurrencyProvider>
  );
}
