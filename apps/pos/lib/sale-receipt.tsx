import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Button, discountLabel, HStack, injectPrintStyle, orderReference, Text, VStack } from '@tallyui/components';
import { buildReceiptData, useCurrencyFormatter, type useSale } from '@tallyui/pos';
import { taxRowLabel } from './cart-totals';
import { MoneyRow, TaxRows } from './sale-cart';

/** The completed sale's receipt, from the order as finalized and stored; New sale starts the next one. */
export function SaleReceipt({ sale, store, cashier, registerId, till }: {
  sale: ReturnType<typeof useSale>; store: string; cashier: string; registerId: string; till?: boolean;
}) {
  const format = useCurrencyFormatter();
  // TallyUI's print style, as its Receipt: what carries print: 'hide' stays off the page, so the receipt prints alone.
  useEffect(injectPrintStyle, []);
  if (sale.stage.kind !== 'receipt') return null;
  const { order, posOrder } = sale.stage;
  const receipt = buildReceiptData(order, { storeName: store, cashier, register: registerId });
  const money = (amount: number) => format({ amount, currency: receipt.currency });
  const { totals } = receipt;
  const taxLabel = `${totals.taxInclusive ? 'incl. ' : ''}Tax`;
  return (
    <VStack testID="receipt" space="none" className="gap-1.5 p-3">
      <Text className="font-semibold">{receipt.header.storeName}</Text>
      <Text testID="receipt-order" className="text-xs text-muted-foreground">Order {orderReference(posOrder)} · {till ? `Till: ${receipt.header.cashier}` : receipt.header.cashier}</Text>
      {order.customer ? <Text testID="receipt-customer" className="text-xs text-muted-foreground">Customer: {order.customer.name}</Text> : null}
      {receipt.lineItems.map((line, index) => (
        <VStack key={index} space="none" className="border-b border-border py-1">
          <HStack space="sm" className="justify-between">
            <Text className="flex-1 text-sm">{line.quantity} × {line.name}</Text>
            <Text className="text-sm">{money(line.displayAmountMinor)}</Text>
          </HStack>
          {/* Before any discount, then the line's own discounts under it, as TallyUI's Receipt (ADR-063). */}
          {line.displayDiscounts.map((discount, i) => (
            <HStack key={i} space="none" className="justify-between pl-4">
              <Text className="text-xs text-muted-foreground">
                {discountLabel(order.lineItems[index].discounts[i], receipt.currency)} off
              </Text>
              <Text testID={`receipt-line-${index}-discount-${i}`} className="text-xs text-muted-foreground">−{money(discount.amountMinor)}</Text>
            </HStack>
          ))}
        </VStack>
      ))}
      {receipt.orderDiscountMinor > 0
        ? <MoneyRow label="Order discount" amount={`−${money(receipt.orderDiscountMinor)}`} testID="receipt-order-discount" /> : null}
      <MoneyRow label="Subtotal" amount={money(totals.subtotalMinor)} testID="receipt-subtotal" />
      {totals.discountMinor > 0 ? <MoneyRow label="Discount" amount={`−${money(totals.discountMinor)}`} testID="receipt-discount" /> : null}
      <TaxRows label={taxLabel} amount={money(totals.taxMinor)} testID="receipt-tax" rates={totals.taxLines.map((tax) => ({
        key: taxRowLabel(totals.taxInclusive, tax.code, tax.ratePpm), name: taxRowLabel(false, tax.code, tax.ratePpm),
        amount: money(tax.amountMinor),
      }))} />
      <MoneyRow label="Total" amount={money(totals.totalMinor)} testID="receipt-total" strong />
      {receipt.payments.map((payment, index) => (
        <MoneyRow key={index} label={payment.method === 'cash' ? 'Cash tendered' : 'Card'} amount={money(payment.amountMinor)}
          testID={`receipt-payment-${payment.method}`} />
      ))}
      <MoneyRow label="Change" amount={money(receipt.changeDueMinor)} testID="receipt-change" strong />
      <HStack dataSet={{ print: 'hide' }} space="sm" className="mt-2">
        {/* The browser's print dialog; native has no print path yet, so no button there. */}
        {Platform.OS === 'web' ? (
          <Button testID="receipt-print" variant="secondary" onPress={() => window.print()}>
            <Text>Print receipt</Text>
          </Button>
        ) : null}
        <Button testID="new-sale" className="flex-1" onPress={sale.newSale}>
          <Text>New sale</Text>
        </Button>
      </HStack>
    </VStack>
  );
}
