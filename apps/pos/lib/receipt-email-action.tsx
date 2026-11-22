import { useCallback, useEffect, useState } from 'react';
import type { RxCollection } from 'rxdb';
import { Button, ReceiptEmailForm, Text, VStack } from '@tallyui/components';
import type { SyncContext } from '@tallyui/core';
import type { PosOrder } from '@tallyui/pos';
import { isWalkIn } from './customer-list';
import { sendReceiptEmail } from './receipt-email';

/** The address the email form starts with: the customer's own, trimmed; never the walk-in's placeholder. */
export function receiptEmailDefault(customer: { email?: string | null; emailAddress?: string | null } | null | undefined): string | undefined {
  const address = (customer?.email ?? customer?.emailAddress)?.trim();
  return address && !isWalkIn(customer) ? address : undefined;
}

/** The store's order code (the plugin's `serverRefs.displayId`, Vendure's `order.code`) once the till's stored order is applied, else null. Read only. */
export function useStoredOrderCode(orders: RxCollection<PosOrder> | null, orderId: string | null): string | null {
  const [stored, setStored] = useState<{ id: string; code: string } | null>(null);
  useEffect(() => {
    if (orders === null || orderId === null) return;
    const subscription = orders.findOne(orderId).$.subscribe((doc) => {
      const code = doc?.syncStatus === 'applied' ? doc.serverRefs?.displayId : undefined;
      setStored(code ? { id: orderId, code } : null);
    });
    return () => subscription.unsubscribe();
  }, [orders, orderId]);
  // Tagged with its order, so another order's code never shows for one beat after the id changes.
  return stored !== null && stored.id === orderId ? stored.code : null;
}

/** The Email receipt panel's toggle: each opening has a new `sendKey`, so a fresh form appears to send again. */
export function useReceiptEmailToggle(): { open: boolean; sendKey: number; toggle(): void } {
  const [open, setOpen] = useState(false);
  const [sendKey, setSendKey] = useState(0);
  const toggle = useCallback(() => {
    if (!open) setSendKey((key) => key + 1);
    setOpen(!open);
  }, [open]);
  return { open, sendKey, toggle };
}

/** The receipt's Email receipt button, in its action row: opens the email panel, or closes it while it is open. */
export function EmailReceiptAction({ testID, open, onToggle }: { testID: string; open: boolean; onToggle(): void }) {
  return (
    <Button testID={testID} variant="secondary" accessibilityState={{ expanded: open }} onPress={onToggle}>
      <Text>Email receipt</Text>
    </Button>
  );
}

/** TallyUI's email form under a receipt, sending to the store's receipt-email route; kept off the printed receipt. */
export function ReceiptEmailPanel({ testID, context, orderCode, defaultAddress, sendKey }: {
  testID: string; context: SyncContext; orderCode: string; defaultAddress?: string; sendKey: number;
}) {
  // No `offline` (there is no send-when-online queue) and no `saveToCustomer` (out of scope): the form draws neither.
  return (
    <VStack dataSet={{ print: 'hide' }} testID={testID} className="px-3 pb-3">
      <ReceiptEmailForm key={sendKey} email={{ defaultAddress, onSend: ({ address }) => sendReceiptEmail(context, orderCode, address) }} />
    </VStack>
  );
}
