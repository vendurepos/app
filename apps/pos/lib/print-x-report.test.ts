import type { RegisterSession, useRegisterSession } from '@tallyui/pos';
import { recordRegisterFact } from '@tallyui/pos';
import { beforeEach, expect, it, vi } from 'vitest';
import { printLines } from './print-lines';
import { printXReport } from './print-x-report';

vi.mock('./print-lines', () => ({ printLines: vi.fn() }));
vi.mock('@tallyui/pos', async (importActual) => ({ ...await importActual<typeof import('@tallyui/pos')>(), recordRegisterFact: vi.fn() }));

const session = {
  id: 'session-1', register_id: 'drawer-1', store_key: 'vendurepos_orders_0000abcd', status: 'open',
  business_day: '2026-09-30', opened_at_gmt: '2026-09-30T07:00:00.000Z', opened_by: 'cashier@example.com',
  expected_float_minor: null, counted_float_minor: 10000, opening_variance_minor: null,
} as RegisterSession;
type Register = ReturnType<typeof useRegisterSession>;
const register = (over: Partial<Register> = {}) =>
  ({ session, expected: { cash: 10000 }, movements: [], salesCount: 0, blind: false, ...over }) as Register;
const actor = { id: 'cashier@example.com', name: 'cashier@example.com' };
const context = { store: 'http://127.0.0.1:3200', currency: 'EUR', timezone: 'UTC', actor };

beforeEach(() => {
  vi.mocked(printLines).mockReset().mockResolvedValue(undefined);
  vi.mocked(recordRegisterFact).mockReset();
});

it('prints the X report, then records it as dispatched', async () => {
  await printXReport(register(), context);
  expect(printLines).toHaveBeenCalledOnce();
  expect(printLines).toHaveBeenCalledWith('X report', expect.arrayContaining(['X report · Register open']));
  expect(recordRegisterFact).toHaveBeenCalledOnce();
  expect(recordRegisterFact).toHaveBeenCalledWith({ kind: 'x-report-dispatched', sessionId: 'session-1', registerId: 'drawer-1', actor });
  expect(vi.mocked(printLines).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(recordRegisterFact).mock.invocationCallOrder[0]);
});

it('rethrows a failed print and records nothing', async () => {
  vi.mocked(printLines).mockRejectedValue(new Error('no printer'));
  await expect(printXReport(register(), context)).rejects.toThrow('no printer');
  expect(recordRegisterFact).not.toHaveBeenCalled();
});

it('prints and records nothing without an open session', async () => {
  await printXReport(register({ session: null }), context);
  await printXReport(register({ session: { ...session, status: 'counting' } as RegisterSession }), context);
  expect(printLines).not.toHaveBeenCalled();
  expect(recordRegisterFact).not.toHaveBeenCalled();
});
