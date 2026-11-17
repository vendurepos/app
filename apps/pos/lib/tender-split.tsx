import { useState } from 'react';
import { Button, HStack, Input, InputField, Text, VStack } from '@tallyui/components';
import { formatMoney, minorUnitDigits } from '@tallyui/core';
import { countsTowardPaid, parseMinor, roundMicrosToMinor, validAmount, type LineItem, type TenderAction, type TenderLineId, type TenderPlan, type TenderState, type useSale } from '@tallyui/pos';

/** CHECKLIST 3.1: an even split takes 2 to 6 parts (v2's even tab); a fixed amount or some items pay first. */
export const SPLIT_WAYS = [2, 3, 4, 5, 6] as const;

/** The reducer's even plan, counted from the captured legs taken so far (TenderPane reads the plan's legs from there). */
export function evenSplitPlan(payments: readonly Parameters<typeof countsTowardPaid>[0][], ways: number): TenderPlan {
  return { kind: 'even', ways, from: payments.filter(countsTowardPaid).length };
}

/** The reducer's fixed plan ("pay this much first, the rest after"), or null unless the typed amount is a valid decimal above 0 and below the balance. */
export function fixedSplitPlan(payments: readonly Parameters<typeof countsTowardPaid>[0][], text: string, currency: string, balanceMinor: number): TenderPlan | null {
  const exponent = minorUnitDigits(currency);
  if (!validAmount(text.trim(), exponent)) return null;
  const firstMinor = parseMinor(text.trim(), exponent);
  if (!(firstMinor > 0 && firstMinor < balanceMinor)) return null;
  return { kind: 'fixed', firstMinor, title: null, from: payments.filter(countsTowardPaid).length };
}

/** A cart line's gross as TallyUI totals it (order-builder sumLines): an inclusive line its net, an exclusive line its net plus its rounded tax. */
export function lineGrossMinor(line: Pick<LineItem, 'netMinor' | 'taxMicros' | 'taxInclusive'>): number {
  return line.taxInclusive ? line.netMinor : line.netMinor + roundMicrosToMinor(BigInt(line.taxMicros));
}

/** The reducer's items plan ("pay these lines first, the rest after"), or null unless at least one line is picked and their gross is above 0 and below the balance. */
export function itemsSplitPlan(payments: readonly Parameters<typeof countsTowardPaid>[0][], lines: readonly Pick<LineItem, 'id' | 'netMinor' | 'taxMicros' | 'taxInclusive'>[], pickedIds: readonly TenderLineId[], balanceMinor: number): TenderPlan | null {
  const picked = lines.filter((line) => pickedIds.includes(line.id));
  if (picked.length === 0) return null;
  const firstMinor = picked.reduce((sum, line) => sum + lineGrossMinor(line), 0);
  if (!(firstMinor > 0 && firstMinor < balanceMinor)) return null;
  return { kind: 'items', lineIds: picked.map((line) => line.id), firstMinor, ways: 1, from: payments.filter(countsTowardPaid).length };
}

/** v2's Split chip, drawn beside TallyUI's TenderPane (which has no slot for it): draws the even, fixed and by-item choices; the reducer works out each leg. */
export function TenderSplit({ sale, state, dispatch }: {
  sale: ReturnType<typeof useSale>; state: TenderState; dispatch: (action: TenderAction) => void;
}) {
  const [amountText, setAmountText] = useState('');
  const fixedPlan = fixedSplitPlan(sale.order.payments, amountText, sale.order.currency, sale.order.balanceDueMinor);
  const itemsPlan = itemsSplitPlan(sale.order.payments, sale.order.lineItems, state.pickedLineIds, sale.order.balanceDueMinor);
  if (sale.stage.kind !== 'tender' || sale.order.balanceDueMinor === 0) return null;
  return (
    <VStack testID="tender-split" space="sm" className="px-4 pt-4">
      <HStack space="sm" className="items-center">
        <Button testID="tender-split-open" variant="outline" size="sm" accessibilityState={{ expanded: state.splitView }}
          onPress={() => dispatch({ type: state.splitView ? 'close-split' : 'open-split' })}>
          <Text>Split</Text>
        </Button>
        {state.plan !== null && (
          <Button testID="tender-split-clear" variant="ghost" size="sm"
            onPress={() => dispatch({ type: 'clear-plan', balanceMinor: sale.order.balanceDueMinor })}>
            <Text>{"Don't split"}</Text>
          </Button>
        )}
      </HStack>
      {state.splitView && (
        <>
        <HStack testID="tender-split-ways" space="sm" className="flex-wrap items-center">
          <Text className="text-sm text-muted-foreground">Split evenly</Text>
          {SPLIT_WAYS.map((ways) => (
            <Button key={ways} testID={`tender-split-ways-${ways}`} variant="outline" size="sm"
              onPress={() => dispatch({ type: 'set-plan', plan: evenSplitPlan(sale.order.payments, ways), balanceMinor: sale.order.balanceDueMinor })}>
              <Text>{`${ways} ways`}</Text>
            </Button>
          ))}
        </HStack>
        <HStack testID="tender-split-amount-row" space="sm" className="flex-wrap items-center">
          <Text className="text-sm text-muted-foreground">Pay first</Text>
          <Input className="w-28"><InputField testID="tender-split-amount" accessibilityLabel="Amount to pay first"
            keyboardType="decimal-pad" value={amountText} onChangeText={setAmountText} /></Input>
          <Button testID="tender-split-amount-set" variant="outline" size="sm" disabled={fixedPlan === null}
            onPress={() => { if (fixedPlan) { dispatch({ type: 'set-plan', plan: fixedPlan, balanceMinor: sale.order.balanceDueMinor }); setAmountText(''); } }}>
            <Text>Then the rest</Text>
          </Button>
        </HStack>
        <VStack testID="tender-split-items" space="xs">
          <Text className="text-sm text-muted-foreground">Pay for items first</Text>
          {sale.order.lineItems.map((line) => {
            const paid = state.linesPaidBy[line.id] !== undefined;
            const picked = state.pickedLineIds.includes(line.id);
            return (
              <Button key={line.id} testID="tender-split-line" variant={picked ? 'default' : 'outline'} size="sm" disabled={paid}
                accessibilityState={{ selected: picked, disabled: paid }}
                onPress={() => dispatch({ type: 'toggle-split-line', lineId: line.id })}>
                <Text>{`${line.quantity} × ${line.name} · ${paid ? 'Paid' : formatMoney({ amount: lineGrossMinor(line), currency: sale.order.currency }) ?? ''}`}</Text>
              </Button>
            );
          })}
          <Button testID="tender-split-items-set" variant="outline" size="sm" disabled={itemsPlan === null}
            onPress={() => { if (itemsPlan) dispatch({ type: 'set-plan', plan: itemsPlan, balanceMinor: sale.order.balanceDueMinor }); }}>
            <Text>Pay these first</Text>
          </Button>
        </VStack>
        </>
      )}
    </VStack>
  );
}
