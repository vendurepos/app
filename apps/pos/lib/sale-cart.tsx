import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button, CartPanel, DiscountChips, DiscountForm, HStack, PriceForm, QuantityStepper, Text, VStack } from '@tallyui/components';
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

/**
 * The Tax row, then each rate's share of it under it, indented, small and muted, "incl. {rate}": a breakdown of the Tax,
 * not addends (vendurepos #70). A rate's testID is `${testID}-${key}`.
 */
export function TaxRows({ label, amount, testID, rates }: {
  label: string; amount: string; testID: string; rates: { key: string; name: string; amount: string }[];
}) {
  return (
    <>
      <MoneyRow label={label} amount={amount} testID={testID} />
      {rates.map((rate) => (
        <HStack key={rate.key} space="none" className="-mt-1 justify-between pl-4">
          <Text className="text-xs text-muted-foreground">incl. {rate.name}</Text>
          <Text testID={`${testID}-${rate.key}`} className="text-xs text-muted-foreground">{rate.amount}</Text>
        </HStack>
      ))}
    </>
  );
}

/**
 * The cart and its Pay buttons. `onPay` starts the tender (through the register's gate); `payGate`, when given, stands
 * in for the Pay buttons (the open-register card while no session is open), and `payError` says why a Pay was refused.
 * `highlightSku` lights up that line, as an add confirms in place.
 */
export function SaleCart({ sale, onPay, payGate, payError, highlightSku, canEditPrice }: {
  sale: ReturnType<typeof useSale>; onPay(method: 'cash' | 'external'): void; payGate?: ReactNode; payError?: string;
  highlightSku?: string; canEditPrice: boolean;
}) {
  const format = useCurrencyFormatter();
  const { order } = sale;
  const money = (amount: number) => format({ amount, currency: order.currency });
  const totals = cartTotals(order);
  const row = (label: string, amount: number, testID: string, strong = false) =>
    <MoneyRow key={testID} label={label} amount={money(amount)} testID={testID} strong={strong} />;
  const empty = !order.lineItems.length;
  const display = (lineId: string) => order.display.lines.find((line) => line.lineId === lineId)!;
  // As TallyUI's own Cart: the open discount form, a line's or the order's (lineId null); useSale applies it or says
  // why not. The order discounts are one display figure, so only a single one's chip carries an amount.
  const [form, setForm] = useState<{ lineId: string | null; kind?: 'price' } | null>(null);
  const discountForm = (lineId: string | null, title: string) => form?.lineId === lineId && form.kind !== 'price'
    ? <DiscountForm key={lineId ?? 'order'} title={title} currency={order.currency} onClose={() => setForm(null)}
      onApply={(discount) => sale.applyDiscount(lineId, discount)} /> : null;
  const orderAmounts = order.discounts.length === 1
    ? [{ discountId: order.discounts[0].id, amountMinor: order.display.orderDiscountMinor }] : [];
  return (
    <CartPanel testID="cart" items={order.lineItems}
      emptyState={<Text className="p-3 text-sm text-muted-foreground">Tap a product to add it to the sale.</Text>}
      afterItems={empty ? undefined : (
        <VStack space="none" className="gap-2 py-2">
          {order.discounts.length ? (
            <View testID="order-discounts">
              <DiscountChips discounts={order.discounts} amounts={orderAmounts} currency={order.currency} onRemove={sale.removeDiscount}
                prefix="Order discount" />
            </View>
          ) : null}
          {discountForm(null, 'Order discount') ?? (
            <Button testID="order-discount" variant="outline" size="sm" className="mx-3 self-start" onPress={() => setForm({ lineId: null })}>
              <Text>Order discount</Text>
            </Button>
          )}
        </VStack>
      )}
      renderItem={(line) => (
        <VStack testID={`cart-line-${line.sku}`} space="none" className="border-b border-border">
          {highlightSku && line.sku === highlightSku ? (
            <View testID={`cart-line-highlight-${line.sku}`} pointerEvents="none" className="absolute inset-0 border border-primary bg-primary/10" />
          ) : null}
          <HStack space="sm" className="items-center px-3 py-2">
            <VStack space="none" className="flex-1">
              <Text className="text-sm font-medium" numberOfLines={2}>{line.name}</Text>
              <Text className="text-xs text-muted-foreground">{money(line.unitPriceMinor)} each</Text>
              <HStack space="sm">
                <Button testID={`line-discount-${line.sku}`} variant="link" size="sm" className="h-7 self-start px-0"
                  onPress={() => setForm({ lineId: line.id })}>
                  <Text className="text-xs">Discount</Text>
                </Button>
                {canEditPrice && <Button testID={`line-price-${line.sku}`} variant="link" size="sm" className="h-7 self-start px-0"
                  onPress={() => setForm({ lineId: line.id, kind: 'price' })}><Text className="text-xs">Price</Text></Button>}
              </HStack>
            </VStack>
            {/* − at 1 takes the line off: TallyUI's updateQuantity removes a line set to 0. */}
            <QuantityStepper quantity={line.quantity} min={0} onChangeQuantity={(quantity) => sale.setQuantity(line.id, quantity)} />
            {/* Before any discount: the line's own discounts are its chips, as TallyUI ADR-063 shows them. */}
            <Text className="w-20 text-right text-sm font-semibold">{money(display(line.id).amountMinor)}</Text>
          </HStack>
          {line.discounts.length ? (
            <View testID={`line-discounts-${line.sku}`} className="pb-2">
              <DiscountChips discounts={line.discounts} amounts={display(line.id).discounts} currency={order.currency}
                onRemove={sale.removeDiscount} />
            </View>
          ) : null}
          {discountForm(line.id, `Discount on ${line.name}`)}
          {canEditPrice && form?.lineId === line.id && form.kind === 'price' && (
            <PriceForm lineName={line.name} currency={order.currency} currentMinor={line.unitPriceMinor}
              onApply={(minor) => { const refusal = sale.setUnitPrice(line.id, minor); if (!refusal) setForm(null); return refusal; }}
              onClose={() => setForm(null)} />
          )}
        </VStack>
      )}
      footer={
        <VStack space="none" className="gap-1.5 py-1">
          {sale.error || payError ? <Text accessibilityRole="alert" className="text-sm text-destructive">{sale.error || payError}</Text> : null}
          {row('Subtotal', totals.subtotalMinor, 'cart-subtotal')}
          {/* TallyUI's display figures (ADR-063), exclusive: subtotal − discount + tax = total. */}
          {order.display.discountMinor > 0
            ? <MoneyRow label="Discount" amount={`−${money(order.display.discountMinor)}`} testID="cart-discount" /> : null}
          <TaxRows label={totals.taxLabel} amount={money(totals.taxMinor)} testID="cart-tax"
            rates={totals.taxRows.map((tax) => ({ key: tax.label, name: tax.name, amount: money(tax.amountMinor) }))} />
          <HStack space="none" className="mt-1 border-t border-border pt-2" />
          {row('Total', totals.totalMinor, 'cart-total', true)}
          {payGate ?? (
            <HStack space="sm" className="mt-2">
              <Button testID="pay-cash" className="flex-1" disabled={empty} onPress={() => onPay('cash')}>
                <Text>Pay cash</Text>
              </Button>
              <Button testID="pay-card" variant="secondary" className="flex-1" disabled={empty} onPress={() => onPay('external')}>
                <Text>Pay by card</Text>
              </Button>
            </HStack>
          )}
        </VStack>
      }
    />
  );
}
