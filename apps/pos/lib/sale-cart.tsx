import { Button, CartPanel, HStack, QuantityStepper, Text, VStack } from '@tallyui/components';
import { useCurrencyFormatter, type useSale } from '@tallyui/pos';
import { cartTotals } from './cart-totals';
import { PROTO_TAXROWS } from './proto-70';

/** A label and its amount on one line, as the cart, tender and receipt show their figures. */
export function MoneyRow({ label, amount, testID, strong = false }: { label: string; amount: string; testID: string; strong?: boolean }) {
  return (
    <HStack space="none" className="justify-between">
      <Text className={strong ? 'font-bold' : 'text-sm text-muted-foreground'}>{label}</Text>
      <Text testID={testID} className={strong ? 'font-bold' : 'text-sm'}>{amount}</Text>
    </HStack>
  );
}

/**
 * PROTOTYPE (#70): the Tax row and its per-rate figures in the style ?taxrows= picks. A: each rate as its own row above
 * Tax (today); B: under Tax, indented and muted, "incl. {rate}"; C: one muted line under Tax, "{rate} {amount} · …".
 */
export function TaxRows({ taxLabel, tax, rates, testID }: {
  taxLabel: string; tax: string; rates: { label: string; name: string; amount: string }[]; testID: string;
}) {
  const total = <MoneyRow label={taxLabel} amount={tax} testID={testID} />;
  if (PROTO_TAXROWS === 'A') {
    return <>{rates.map((rate) => <MoneyRow key={rate.label} label={rate.label} amount={rate.amount} testID={`${testID}-${rate.label}`} />)}{total}</>;
  }
  if (PROTO_TAXROWS === 'B') {
    return (
      <>{total}{rates.map((rate) => (
        <HStack key={rate.label} space="none" className="-mt-1 justify-between pl-4">
          <Text className="text-xs text-muted-foreground">incl. {rate.name}</Text>
          <Text className="text-xs text-muted-foreground">{rate.amount}</Text>
        </HStack>
      ))}</>
    );
  }
  return (
    <>{total}{rates.length ? (
      <Text className="-mt-1 text-xs text-muted-foreground">{rates.map((rate) => `${rate.name} ${rate.amount}`).join(' · ')}</Text>
    ) : null}</>
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
          <TaxRows taxLabel={totals.taxLabel} tax={money(totals.taxMinor)} testID="cart-tax"
            rates={totals.taxRows.map((tax) => ({ ...tax, amount: money(tax.amountMinor) }))} />
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
