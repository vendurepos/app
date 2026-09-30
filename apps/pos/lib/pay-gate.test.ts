import { RegisterSessionRequiredError, type RegisterSessionCollection } from '@tallyui/pos';
import { expect, it, vi } from 'vitest';
import { OPEN_REGISTER_TEXT, startTenderInSession } from './pay-gate';

const session = { id: 'session-1', sessions: {} as RegisterSessionCollection };

it('starts the tender pinned to the open session the register confirms from storage', async () => {
  const sale = { startTender: vi.fn() };
  expect(await startTenderInSession({ requireSaleSession: async () => session }, sale, 'external')).toBeUndefined();
  expect(sale.startTender).toHaveBeenCalledWith('external', { session });
});

it.each([
  ['no session is open', async () => { throw new RegisterSessionRequiredError(); }],
  // Sessions off, or the database still opening: this till never sells outside a session.
  ['the register answers none', async () => null],
])('takes no payment when %s', async (_, requireSaleSession) => {
  const sale = { startTender: vi.fn() };
  expect(await startTenderInSession({ requireSaleSession }, sale, 'cash')).toBe(OPEN_REGISTER_TEXT);
  expect(sale.startTender).not.toHaveBeenCalled();
});
