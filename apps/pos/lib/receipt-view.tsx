import { useEffect, type JSX, type ReactNode } from 'react';
import { HStack, injectPrintStyle, Text, VStack } from '@tallyui/components';
import { useCurrencyFormatter, type ReceiptData } from '@tallyui/pos';
import { taxRowLabel } from './cart-totals';
import { MoneyRow, TaxRows } from './sale-cart';

/** A receipt's layout, shared by the live sale's receipt and a stored order's reprint; every testid is built from testID. */
export function ReceiptView({ receipt, testID, orderLine, customer, lineDiscountLabel, actions }: {
  receipt: ReceiptData; testID: string; orderLine: string; customer?: string;
  lineDiscountLabel(lineIndex: number, discountIndex: number): string; actions: ReactNode;
}): JSX.Element {
  const format = useCurrencyFormatter();
  // TallyUI's print style, as its Receipt: what carries print: 'hide' stays off the page, so the receipt prints alone.
  useEffect(injectPrintStyle, []);
  const money = (amount: number) => format({ amount, currency: receipt.currency });
  const { totals } = receipt;
  const taxLabel = `${totals.taxInclusive ? 'incl. ' : ''}Tax`;
  return (
    <VStack testID={testID} space="none" className="gap-1.5 p-3">
      <Text className="font-semibold">{receipt.header.storeName}</Text>
      <Text testID={`${testID}-order`} className="text-xs text-muted-foreground">{orderLine}</Text>
      {customer ? <Text testID={`${testID}-customer`} className="text-xs text-muted-foreground">Customer: {customer}</Text> : null}
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
                {lineDiscountLabel(index, i)}
              </Text>
              <Text testID={`${testID}-line-${index}-discount-${i}`} className="text-xs text-muted-foreground">−{money(discount.amountMinor)}</Text>
            </HStack>
          ))}
        </VStack>
      ))}
      {receipt.orderDiscountMinor > 0
        ? <MoneyRow label="Order discount" amount={`−${money(receipt.orderDiscountMinor)}`} testID={`${testID}-order-discount`} /> : null}
      <MoneyRow label="Subtotal" amount={money(totals.subtotalMinor)} testID={`${testID}-subtotal`} />
      {totals.discountMinor > 0 ? <MoneyRow label="Discount" amount={`−${money(totals.discountMinor)}`} testID={`${testID}-discount`} /> : null}
      {/* The subtotal excludes charges (TallyUI ADR-075), so they sit between it and the tax. */}
      {receipt.fees.map((charge, index) => <MoneyRow key={`fee-${index}`} label={charge.name} amount={money(charge.amountMinor)} testID={`${testID}-fee-${index}`} />)}
      {receipt.shipping.map((charge, index) => <MoneyRow key={`shipping-${index}`} label={charge.name} amount={money(charge.amountMinor)} testID={`${testID}-shipping-${index}`} />)}
      <TaxRows label={taxLabel} amount={money(totals.taxMinor)} testID={`${testID}-tax`} rates={totals.taxLines.map((tax) => ({
        key: taxRowLabel(totals.taxInclusive, tax.code, tax.ratePpm), name: taxRowLabel(false, tax.code, tax.ratePpm),
        amount: money(tax.amountMinor),
      }))} />
      <MoneyRow label="Total" amount={money(totals.totalMinor)} testID={`${testID}-total`} strong />
      {receipt.payments.map((payment, index) => (
        <MoneyRow key={index} label={payment.method === 'cash' ? 'Cash tendered' : 'Card'} amount={money(payment.amountMinor)}
          testID={`${testID}-payment-${payment.method}`} />
      ))}
      <MoneyRow label="Change" amount={money(receipt.changeDueMinor)} testID={`${testID}-change`} strong />
      <HStack dataSet={{ print: 'hide' }} space="sm" className="mt-2">
        {actions}
      </HStack>
    </VStack>
  );
}
