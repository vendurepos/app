import { useState, type JSX } from 'react';
import { View } from 'react-native';
import { Button, Card, Text } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { useRegisterSession } from '@tallyui/pos';
import { openSince } from './open-since';

/** v2's Reports drawer card (CHECKLIST 8.1): the open register, float + cash sales = expected in the drawer, Print X-report, and the panel. */
export function ReportsDrawerCard({ register, currency, cashier, onPrintXReport, onOpenRegister }: {
  register: ReturnType<typeof useRegisterSession>; currency: string; cashier: string;
  onPrintXReport(): Promise<void>; onOpenRegister(): void;
}): JSX.Element | null {
  const [printError, setPrintError] = useState<string | null>(null);
  if (register.session?.status !== 'open') return null;
  const opened = new Date(register.session.opened_at_gmt);
  const money = (amount: number) => formatMoney({ amount, currency }) ?? '';
  const terms = register.terms;
  const print = async () => {
    try {
      await onPrintXReport();
      setPrintError(null);
    } catch (e) {
      setPrintError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card testID="reports-drawer" className="flex-row flex-wrap items-center gap-4 p-4">
      <Text testID="reports-drawer-status" className="font-semibold">
        {`Register · Open since ${openSince(opened, new Date())} · ${cashier}`}
      </Text>
      {!register.blind && terms ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text testID="reports-drawer-float">{`Opening float ${money(terms.floatMinor)}`}</Text>
          <Text>+</Text>
          <Text testID="reports-drawer-cash-sales">{`Cash sales · ${terms.cashSales.count} ${money(terms.cashSales.amountMinor)}`}</Text>
          <Text>=</Text>
          <Text testID="reports-drawer-expected" className="font-semibold">{`Expected in drawer ${money(terms.expected.cash ?? 0)}`}</Text>
        </View>
      ) : null}
      <Button testID="reports-drawer-print-x" variant="outline" onPress={() => void print()}>
        <Text>Print X-report</Text>
      </Button>
      {printError ? <Text testID="reports-drawer-print-error" className="text-sm text-destructive">{printError}</Text> : null}
      <Button testID="reports-drawer-open-register" variant="ghost" accessibilityLabel="Open the register panel" onPress={onOpenRegister}>
        <Text>›</Text>
      </Button>
    </Card>
  );
}
