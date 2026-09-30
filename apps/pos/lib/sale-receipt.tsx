import { Button, HStack, Text, VStack } from '@tallyui/components';
import { buildReceiptData, useCurrencyFormatter, type useSale } from '@tallyui/pos';
import { taxRowLabel } from './cart-totals';
import { MoneyRow, TaxRows } from './sale-cart';

/** The completed sale's receipt, from the order as finalized and stored; New sale starts the next one. */
export function SaleReceipt({ sale, store, cashier, registerId }: {
  sale: ReturnType<typeof useSale>; store: string; cashier: string; registerId: string;
}) {
  const format = useCurrencyFormatter();
  if (sale.stage.kind !== 'receipt') return null;
  const receipt = buildReceiptData(sale.stage.order, { storeName: store, cashier, register: registerId });
  const money = (amount: number) => format({ amount, currency: receipt.currency });
  const { totals } = receipt;
  const taxLabel = `${totals.taxInclusive ? 'incl. ' : ''}Tax`;
  return (
    <VStack testID="receipt" space="none" className="gap-1.5 p-3">
      <Text className="font-semibold">{receipt.header.storeName}</Text>
      <Text className="text-xs text-muted-foreground">Order {receipt.header.orderNumber.slice(-8)} · {receipt.header.cashier}</Text>
      {receipt.lineItems.map((line, index) => (
        <HStack key={index} space="sm" className="justify-between border-b border-border py-1">
          <Text className="flex-1 text-sm">{line.quantity} × {line.name}</Text>
          <Text className="text-sm">{money(line.displayAmountMinor)}</Text>
        </HStack>
      ))}
      <MoneyRow label="Subtotal" amount={money(totals.subtotalMinor)} testID="receipt-subtotal" />
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
      <Button testID="new-sale" className="mt-2" onPress={sale.newSale}>
        <Text>New sale</Text>
      </Button>
    </VStack>
  );
}
