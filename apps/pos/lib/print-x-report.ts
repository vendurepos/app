import { recordRegisterFact, type Actor, type useRegisterSession } from '@tallyui/pos';
import { printLines } from './print-lines';
import { xReportLines } from './x-report';

/**
 * Prints the open session's X report and records it as a register fact once the print is sent. v2 prints the X report
 * from the register panel's footer (parity 6.2), so this is the panel's `onPrintXReport`: a failed print rethrows and
 * records nothing, and the panel shows its "Printing failed" line. Without an open session it does nothing.
 */
export async function printXReport(register: ReturnType<typeof useRegisterSession>, { store, currency, timezone, actor }: {
  store: string; currency: string; timezone: string; actor: Actor;
}): Promise<void> {
  const { session } = register;
  if (session?.status !== 'open') return;
  await printLines('X report', xReportLines({
    session, expected: register.expected, movements: register.movements, salesCount: register.salesCount, blind: register.blind,
  }, { store, currency, timezone, printedAt: new Date().toISOString() }));
  recordRegisterFact({ kind: 'x-report-dispatched', sessionId: session.id, registerId: session.register_id, actor });
}
