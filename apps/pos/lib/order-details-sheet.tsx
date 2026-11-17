import { useState, type JSX } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, HStack, Text } from '@tallyui/components';

/**
 * v2's Order details dialog (CHECKLIST 2.11), opened by the ⋮ beside Checkout: a side sheet from the left with Void and Close.
 * Void is `useSale().closeSale()`, which refuses a sale that is saving, partly paid or in tender; the refusal shows in the sheet.
 */
export function OrderDetailsSheet({ open, onOpenChange, onVoid }: {
  open: boolean; onOpenChange(open: boolean): void; onVoid(): string | null;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { setError(null); onOpenChange(next); }}>
      <DialogContent testID="order-details" dataSet={{ print: 'hide' }}
        className="left-0 right-auto top-0 h-full max-w-sm translate-x-0 translate-y-0 rounded-none border-0 border-r">
        <DialogHeader className="text-left">
          <DialogTitle>Order details</DialogTitle>
          <DialogDescription>Void drops this sale from the till. Nothing has been sent to the store.</DialogDescription>
        </DialogHeader>
        {error ? <Text testID="order-details-error" accessibilityRole="alert" className="text-sm text-destructive">{error}</Text> : null}
        <HStack space="sm" className="mt-auto justify-between">
          <Button testID="order-details-void" variant="outline" className="border-destructive" onPress={() => {
            const refusal = onVoid(); // A refusal stays in the sheet; with none the error clears and the sheet closes.
            setError(refusal);
            if (!refusal) onOpenChange(false);
          }}>
            <Text className="text-destructive">Void</Text>
          </Button>
          <Button testID="order-details-close" variant="outline" onPress={() => onOpenChange(false)}>
            <Text>Close</Text>
          </Button>
        </HStack>
      </DialogContent>
    </Dialog>
  );
}
