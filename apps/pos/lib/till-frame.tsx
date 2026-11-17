import { useState, type JSX, type ReactNode } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, HStack, MovementSheet, Text, VStack, type ShellNavItem,
} from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { MovementType, useRegisterSession } from '@tallyui/pos';
import { CashIcon, CustomersIcon, OrdersIcon, PosIcon, ReportsIcon, SettingsIcon, SupportIcon } from './nav-icons';
import type { TillNavEntry, TillNavId } from './till-nav';

const GLYPH: Record<TillNavId, typeof PosIcon> = {
  pos: PosIcon, orders: OrdersIcon, customers: CustomersIcon, reports: ReportsIcon, register: CashIcon, settings: SettingsIcon, support: SupportIcon,
};
// The ids the e2e specs press for the doors the nav took over. Register's stays on the bar's door, which phones show too.
const DOOR_TEST_ID: Partial<Record<TillNavId, string>> = { orders: 'orders-open', customers: 'customers-open', reports: 'reports-open', settings: 'settings-open', support: 'support-open' };
// The quick-start guide on the marketing site's docs (the demo banner's Quick start link).
const SUPPORT_QUICKSTART_URL = 'https://vendurepos.com/docs/quick-start';
// The app repo's GitHub issues, where a merchant reports a problem.
const SUPPORT_ISSUES_URL = 'https://github.com/vendurepos/app/issues';

/** The shell's nav items for the till's entries (lib/till-nav.ts), each with its glyph. */
export function tillNavItems(entries: TillNavEntry[]): ShellNavItem[] {
  return entries.map(({ id, ...entry }) => {
    const Glyph = GLYPH[id];
    return { id, ...entry, icon: <View testID={DOOR_TEST_ID[id]}><Glyph size={24} /></View> };
  });
}

/**
 * The cashier's menu, opened from the bar's avatar: a side sheet as Tally Woo's `cashier-sheet.tsx` (v2's user sheet),
 * holding the shift's actions, Hand over and Sign out with its lock message.
 */
export function CashierSheet({ open, onOpenChange, name, store, children, locked, pending, onHandOver, onSignOut }: {
  open: boolean; onOpenChange(open: boolean): void; name: string; store: string; children: ReactNode;
  locked: string | null | undefined; pending: boolean; onHandOver?(): void; onSignOut(): void;
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
        <HStack className="self-end" space="sm">
          {onHandOver ? <Button testID="hand-over" variant="outline" disabled={pending || !!locked} onPress={onHandOver}><Text>Hand over</Text></Button> : null}
          <Button testID="sign-out" variant="destructive" disabled={pending || !!locked} onPress={onSignOut}>
            <Text>Sign out</Text>
          </Button>
        </HStack>
      </DialogContent>
    </Dialog>
  );
}

/** v2's avatar sheet's shift block (CHECKLIST 6.1): the register and since, the session's sales, the drawer, and its actions. */
export function CashierShift({ register, currency, onClosing }: {
  register: ReturnType<typeof useRegisterSession>; currency: string; onClosing(): void;
}): JSX.Element | null {
  const [type, setType] = useState<MovementType | null>(null);
  const [error, setError] = useState('');
  if (register.session?.status !== 'open') return null;
  const opened = new Date(register.session.opened_at_gmt);
  const since = `${String(opened.getHours()).padStart(2, '0')}:${String(opened.getMinutes()).padStart(2, '0')}`;
  const money = (amount: number) => formatMoney({ amount, currency }) ?? '';
  const close = async () => {
    try {
      await register.actions.startCounting();
      onClosing();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <VStack testID="cashier-shift" space="sm">
      <Text testID="cashier-shift-since">{`Register · open since ${since}`}</Text>
      {!register.blind && register.terms ? (
        <>
          <Text testID="cashier-shift-sales">
            {`Session sales ${money(register.terms.sessionSalesMinor)} · ${register.salesCount} sale${register.salesCount === 1 ? '' : 's'}`}
          </Text>
          <Text testID="cashier-shift-drawer">{`In the drawer ${money(register.terms.expected.cash ?? 0)}`}</Text>
        </>
      ) : null}
      <HStack space="sm">
        <Button testID="cashier-shift-pay-in" variant="outline" onPress={() => setType('paid_in')}><Text>Pay in</Text></Button>
        <Button testID="cashier-shift-pay-out" variant="outline" onPress={() => setType('paid_out')}><Text>Pay out</Text></Button>
        <Button testID="cashier-shift-close-register" variant="outline" onPress={close}><Text>Close register</Text></Button>
      </HStack>
      {error ? <Text testID="cashier-shift-error" className="text-sm text-destructive">{error}</Text> : null}
      {type ? (
        <MovementSheet register={register} type={type} currency={currency}
          onOpenChange={(open) => { if (!open) setType(null); }} onDone={() => setType(null)} />
      ) : null}
    </VStack>
  );
}

/**
 * Support, at the foot of the rail where v2 opens its chat (v2 parity 11.2): VendurePOS has no chat, so a side sheet as
 * the cashier's holds the quick-start guide, the GitHub issues and the app version.
 */
export function SupportSheet({ open, onOpenChange, version }: {
  open: boolean; onOpenChange(open: boolean): void; version: string;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent testID="support-sheet" dataSet={{ print: 'hide' }}
        className="left-auto right-0 top-0 h-full max-w-sm translate-x-0 translate-y-0 rounded-none border-0 border-l">
        <DialogHeader className="text-left">
          <DialogTitle>Support</DialogTitle>
          <DialogDescription>Help with VendurePOS</DialogDescription>
        </DialogHeader>
        <VStack className="items-start" space="sm">
          <Link href={SUPPORT_QUICKSTART_URL} target="_blank" rel="noopener" testID="support-quickstart" className="text-primary">Quick start guide</Link>
          <Link href={SUPPORT_ISSUES_URL} target="_blank" rel="noopener" testID="support-issues" className="text-primary">Report a problem on GitHub</Link>
        </VStack>
        <Text testID="support-version" className="text-sm text-muted-foreground">{`VendurePOS ${version}`}</Text>
      </DialogContent>
    </Dialog>
  );
}
