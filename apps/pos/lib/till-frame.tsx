import type { JSX, ReactNode } from 'react';
import { View } from 'react-native';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Text, VStack, type ShellNavItem } from '@tallyui/components';
import { CashIcon, OrdersIcon, PosIcon, SettingsIcon } from './nav-icons';
import type { TillNavEntry, TillNavId } from './till-nav';

const GLYPH: Record<TillNavId, typeof PosIcon> = { pos: PosIcon, orders: OrdersIcon, register: CashIcon, settings: SettingsIcon };
// The ids the e2e specs press for the doors the nav took over. Register's stays on the bar's door, which phones show too.
const DOOR_TEST_ID: Partial<Record<TillNavId, string>> = { orders: 'orders-open', settings: 'settings-open' };

/** The shell's nav items for the till's entries (lib/till-nav.ts), each with its glyph. */
export function tillNavItems(entries: TillNavEntry[]): ShellNavItem[] {
  return entries.map(({ id, ...entry }) => {
    const Glyph = GLYPH[id];
    return { id, ...entry, icon: <View testID={DOOR_TEST_ID[id]}><Glyph size={24} /></View> };
  });
}

/**
 * The cashier's menu, opened from the bar's avatar: a side sheet as Tally Woo's `cashier-sheet.tsx` (v2's user sheet),
 * holding the shift's actions and Sign out with its lock message.
 */
export function CashierSheet({ open, onOpenChange, name, store, children, locked, pending, onSignOut }: {
  open: boolean; onOpenChange(open: boolean): void; name: string; store: string; children: ReactNode;
  locked: string | null | undefined; pending: boolean; onSignOut(): void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent testID="cashier-sheet" dataSet={{ print: 'hide' }}
        className="left-auto right-0 top-0 h-full max-w-sm translate-x-0 translate-y-0 rounded-none border-0 border-l">
        <DialogHeader className="text-left">
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{store}</DialogDescription>
        </DialogHeader>
        <VStack className="items-start" space="sm">{children}</VStack>
        {/* A record() not yet settled would be lost with the sale, and a close with its Z; the outbox closes its store at unmount. */}
        {locked && !pending ? <Text testID="sign-out-locked" className="text-sm text-muted-foreground">{locked}</Text> : null}
        <Button testID="sign-out" variant="destructive" className="self-end" disabled={pending || !!locked} onPress={onSignOut}>
          <Text>Sign out</Text>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
