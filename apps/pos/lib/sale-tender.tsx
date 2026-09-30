import { Button, CashTendered, ChangeDisplay, Text, VStack } from '@tallyui/components';
import { minorUnitDigits } from '@tallyui/core';
import { MAX_TENDER_MINOR, quickTenderedAmounts, useCurrencyFormatter, type useSale } from '@tallyui/pos';
import { MoneyRow } from './sale-cart';

// Cash quick amounts: the total, then the next whole 5, 10 and 50 above it, in major units.
const QUICK_STEPS_MAJOR = [5, 10, 50];

/**
 * The tender, one payment per sale (useSale's setTender keeps a single payment, so no split yet). Cash takes a
 * quick or typed amount and shows the change; card is taken for the exact total. A failed save offers Retry,
 * and Continue only once useSale's isStored confirms the order is stored.
 */
export function SaleTender({ sale }: { sale: ReturnType<typeof useSale> }) {
  const format = useCurrencyFormatter();
  const { order, stage } = sale;
  if (stage.kind !== 'tender') return null;
  const { currency } = order;
  const cash = stage.method === 'cash';
  const unit = 10 ** minorUnitDigits(currency);
  const quickAmounts = quickTenderedAmounts(order.totalMinor, QUICK_STEPS_MAJOR.map((step) => step * unit))
    .map((amount) => ({ amount, currency }));
  const failed = sale.saving && !!sale.error;
  return (
    <VStack testID="tender" space="none" className="gap-3 p-3">
      <MoneyRow label="Total" amount={format({ amount: order.totalMinor, currency })} testID="tender-total" strong />
      {cash ? <>
        <CashTendered testID="cash-tendered" total={{ amount: order.totalMinor, currency }} quickAmounts={quickAmounts}
          amount={{ amount: order.payments[0]?.amountMinor ?? 0, currency }}
          onChangeAmount={(amount) => sale.setTender({ method: 'cash', amountMinor: Math.min(amount.amount, MAX_TENDER_MINOR) })} />
        <ChangeDisplay testID="tender-change" change={{ amount: order.changeDueMinor, currency }} />
      </> : <Text className="text-sm text-muted-foreground">Take the total on the card terminal, then confirm it here.</Text>}
      {sale.error ? <Text accessibilityRole="alert" className="text-sm text-destructive">{sale.error}</Text> : null}
      <Button testID="tender-complete" disabled={order.balanceDueMinor > 0 || (sale.saving && !failed)} onPress={() => void sale.complete()}>
        <Text>{failed ? 'Retry' : sale.saving ? 'Saving…' : cash ? 'Complete sale' : 'Card payment approved'}</Text>
      </Button>
      {sale.canContinue ? (
        <Button testID="tender-continue" variant="secondary" onPress={sale.continueSale}>
          <Text>Continue: this sale is stored and will be sent</Text>
        </Button>
      ) : null}
      <Button testID="tender-back" variant="outline" disabled={sale.saving} onPress={sale.cancelTender}>
        <Text>Back to the cart</Text>
      </Button>
    </VStack>
  );
}
