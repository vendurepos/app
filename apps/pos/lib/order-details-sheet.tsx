import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, HStack, Label, Text, Textarea } from '@tallyui/components';
import { ORDER_NOTE_MAX } from '@tallyui/core';
import { injectPrintOnlyStyle } from './print-only-style';

/**
 * v2's Order details dialog (CHECKLIST 2.11), opened by the ⋮ beside Checkout: a side sheet from the left with Void and Close.
 * Void is `useSale().closeSale()`, which refuses a sale that is saving, partly paid or in tender; the refusal shows in the sheet.
 * The Customer note (v2's, CHECKLIST 2.11) is useSale().setNote, offered only when the store accepts order.create 7 (onNote set).
 * Print (web) prints the open sale as an unpaid bill: only the bill reaches the page, and nothing in the sale changes.
 */
export function OrderDetailsSheet({ open, onOpenChange, onVoid, note, onNote, bill }: {
  open: boolean; onOpenChange(open: boolean): void; onVoid(): string | null; note: string; onNote?(note: string): void; bill?: ReactNode;
}): JSX.Element {
  useEffect(injectPrintOnlyStyle, []);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { setError(null); onOpenChange(next); }}>
      <DialogContent testID="order-details" dataSet={bill ? { print: 'sheet' } : { print: 'hide' }}
        className="left-0 right-auto top-0 h-full max-w-sm translate-x-0 translate-y-0 rounded-none border-0 border-r">
        <View dataSet={{ print: 'hide' }} className="flex-1 gap-4">
          <DialogHeader className="text-left">
            <DialogTitle>Order details</DialogTitle>
            <DialogDescription>Void drops this sale from the till. Nothing has been sent to the store.</DialogDescription>
          </DialogHeader>
          {onNote && <HStack space="md" className="items-start">
            <Label nativeID="order-details-note-label" className="w-28 pt-2">Customer note</Label>
            <Textarea testID="order-details-note" className="flex-1" value={note} onChangeText={onNote} maxLength={ORDER_NOTE_MAX}
              placeholder="Add customer note" accessibilityLabel="Customer note" accessibilityLabelledBy="order-details-note-label" />
          </HStack>}
          {error ? <Text testID="order-details-error" accessibilityRole="alert" className="text-sm text-destructive">{error}</Text> : null}
          <HStack space="sm" className="mt-auto justify-between">
            <Button testID="order-details-void" variant="outline" className="border-destructive" onPress={() => {
              const refusal = onVoid(); // A refusal stays in the sheet; with none the error clears and the sheet closes.
              setError(refusal);
              if (!refusal) onOpenChange(false);
            }}>
              <Text className="text-destructive">Void</Text>
            </Button>
            <HStack space="sm">
              <Button testID="order-details-close" variant="outline" onPress={() => onOpenChange(false)}>
                <Text>Close</Text>
              </Button>
              {bill && Platform.OS === 'web' ? (
                <Button testID="order-details-print" variant="outline" onPress={() => window.print()}><Text>Print</Text></Button>
              ) : null}
            </HStack>
          </HStack>
        </View>
        {bill ? <View testID="order-details-bill" dataSet={{ print: 'only' }}>{bill}</View> : null}
      </DialogContent>
    </Dialog>
  );
}
