import { useState, type JSX } from 'react';
import { Button, Text } from '@tallyui/components';
import { recordRegisterFact, type Actor, type useRegisterSession } from '@tallyui/pos';
import { printLines } from './print-lines';
import { xReportLines } from './x-report';

export function XReportButton({ register, store, currency, timezone, actor }: {
  register: ReturnType<typeof useRegisterSession>; store: string; currency: string; timezone: string; actor: Actor;
}): JSX.Element | null {
  const [error, setError] = useState('');
  const { session } = register;
  if (session?.status !== 'open') return null;
  const print = async () => {
    setError('');
    try {
      await printLines('X report', xReportLines({
        session, expected: register.expected, movements: register.movements, salesCount: register.salesCount, blind: register.blind,
      }, { store, currency, timezone, printedAt: new Date().toISOString() }));
      recordRegisterFact({ kind: 'x-report-dispatched', sessionId: session.id, registerId: session.register_id, actor });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <Button testID="register-print-x" variant="secondary" accessibilityLabel="Print the X report" onPress={print}>
        <Text>X report</Text>
      </Button>
      {error ? <Text testID="register-print-x-error" className="text-sm text-destructive">{error}</Text> : null}
    </>
  );
}
