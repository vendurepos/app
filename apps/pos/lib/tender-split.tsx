import { Button, HStack, Text, VStack } from '@tallyui/components';
import { countsTowardPaid, type TenderAction, type TenderPlan, type TenderState, type useSale } from '@tallyui/pos';

/** CHECKLIST 3.1: an even split takes 2 to 6 parts (v2's even tab). Fixed amounts and by-item splits are later lanes. */
export const SPLIT_WAYS = [2, 3, 4, 5, 6] as const;

/** The reducer's even plan, counted from the captured legs taken so far (TenderPane reads the plan's legs from there). */
export function evenSplitPlan(payments: readonly Parameters<typeof countsTowardPaid>[0][], ways: number): TenderPlan {
  return { kind: 'even', ways, from: payments.filter(countsTowardPaid).length };
}

/** v2's Split chip, drawn beside TallyUI's TenderPane (which has no slot for it): picks an even split; the reducer works out each share. */
export function TenderSplit({ sale, state, dispatch }: {
  sale: ReturnType<typeof useSale>; state: TenderState; dispatch: (action: TenderAction) => void;
}) {
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
        <HStack testID="tender-split-ways" space="sm" className="flex-wrap items-center">
          <Text className="text-sm text-muted-foreground">Split evenly</Text>
          {SPLIT_WAYS.map((ways) => (
            <Button key={ways} testID={`tender-split-ways-${ways}`} variant="outline" size="sm"
              onPress={() => dispatch({ type: 'set-plan', plan: evenSplitPlan(sale.order.payments, ways), balanceMinor: sale.order.balanceDueMinor })}>
              <Text>{`${ways} ways`}</Text>
            </Button>
          ))}
        </HStack>
      )}
    </VStack>
  );
}
