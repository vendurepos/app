import { Button, CartPanel, HStack, QuantityStepper, Text, VStack } from '@tallyui/components';
import { useCurrencyFormatter, type useSale } from '@tallyui/pos';
import { cartTotals } from './cart-totals';

/** A label and its amount on one line, as the cart, tender and receipt show their figures. */
export function MoneyRow({ label, amount, testID, strong = false }: { label: string; amount: string; testID: string; strong?: boolean }) {
  return (
    <HStack space="none" className="justify-between">
      <Text className={strong ? 'font-bold' : 'text-sm text-muted-foreground'}>{label}</Text>
      <Text testID={testID} className={strong ? 'font-bold' : 'text-sm'}>{amount}</Text>
    </HStack>
  );
}

export function SaleCart({ sale }: { sale: ReturnType<typeof useSale> }) {
  const format = useCurrencyFormatter();
  const { order } = sale;
  const money = (amount: number) => format({ amount, currency: order.currency });
  const totals = cartTotals(order);
  const row = (label: string, amount: number, testID: string, strong = false) =>
    <MoneyRow key={testID} label={label} amount={money(amount)} testID={testID} strong={strong} />;
  const empty = !order.lineItems.length;
  return (
    <CartPanel testID="cart" items={order.lineItems}
      emptyState={<Text className="p-3 text-sm text-muted-foreground">Tap a product to add it to the sale.</Text>}
      renderItem={(line) => (
        <HStack testID={`cart-line-${line.sku}`} space="sm" className="items-center border-b border-border px-3 py-2">
          <VStack space="none" className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={2}>{line.name}</Text>
            <Text className="text-xs text-muted-foreground">{money(line.unitPriceMinor)} each</Text>
          </VStack>
          {/* − at 1 takes the line off: TallyUI's updateQuantity removes a line set to 0. */}
          <QuantityStepper quantity={line.quantity} min={0} onChangeQuantity={(quantity) => sale.setQuantity(line.id, quantity)} />
          <Text className="w-20 text-right text-sm font-semibold">
            {money(order.display.lines.find((display) => display.lineId === line.id)!.amountMinor)}
          </Text>
        </HStack>
      )}
      footer={
        <VStack space="none" className="gap-1.5 py-1">
          {sale.error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{sale.error}</Text> : null}
          {row('Subtotal', totals.subtotalMinor, 'cart-subtotal')}
          {totals.taxRows.map((tax) => row(tax.label, tax.amountMinor, `cart-tax-${tax.label}`))}
          {row(totals.taxLabel, totals.taxMinor, 'cart-tax')}
          <HStack space="none" className="mt-1 border-t border-border pt-2" />
          {row('Total', totals.totalMinor, 'cart-total', true)}
          <HStack space="sm" className="mt-2">
            <Button testID="pay-cash" className="flex-1" disabled={empty} onPress={() => sale.startTender('cash')}>
              <Text>Pay cash</Text>
            </Button>
            <Button testID="pay-card" variant="secondary" className="flex-1" disabled={empty} onPress={() => sale.startTender('external')}>
              <Text>Pay by card</Text>
            </Button>
          </HStack>
        </VStack>
      }
    />
  );
}
