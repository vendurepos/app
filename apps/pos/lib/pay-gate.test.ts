import { RegisterSessionRequiredError, type RegisterSessionCollection } from '@tallyui/pos';
import { expect, it, vi } from 'vitest';
import { OPEN_REGISTER_TEXT, startTenderInSession } from './pay-gate';

const session = { id: 'session-1', sessions: { findOne: () => ({ exec: async () => ({ register_id: 'drawer-1' }) }) } as RegisterSessionCollection };

it('starts the tender pinned to the open session the register confirms from storage', async () => {
  const sale = { startTender: vi.fn() };
  expect(await startTenderInSession({ requireSaleSession: async () => session }, sale, 'external')).toBeUndefined();
  expect(sale.startTender).toHaveBeenCalledWith('external', { session });
});

it("hands the pinned session's drawer to pin before the tender starts", async () => {
  const sale = { startTender: vi.fn() };
  const pin = vi.fn();
  await startTenderInSession({ requireSaleSession: async () => session }, sale, 'cash', pin);
  expect(pin).toHaveBeenCalledExactlyOnceWith('drawer-1');
  expect(pin.mock.invocationCallOrder[0]).toBeLessThan(sale.startTender.mock.invocationCallOrder[0]);
  expect(sale.startTender).toHaveBeenCalledWith('cash', { session });
});

it("after a mid-cart rebind, the sale's register and its session name the same drawer", async () => {
  let bound = 'drawer-A';
  const sessions = {
    findOne: (id: string) => ({ exec: async () => ({ register_id: id === 'session-A' ? 'drawer-A' : 'drawer-B' }) }),
  };
  const register = { requireSaleSession: async () => ({
    id: bound === 'drawer-A' ? 'session-A' : 'session-B', sessions: sessions as RegisterSessionCollection,
  }) };
  const sale = { startTender: vi.fn() };
  const pin = vi.fn();
  bound = 'drawer-B';
  await startTenderInSession(register, sale, 'cash', pin);
  expect(pin).toHaveBeenCalledExactlyOnceWith('drawer-B');
  const pinnedSession = sale.startTender.mock.calls[0][1].session;
  expect(pin.mock.calls[0][0]).toBe((await sessions.findOne(pinnedSession.id).exec()).register_id);
});

it.each([
  ['no session is open', async () => { throw new RegisterSessionRequiredError(); }],
  // Sessions off, or the database still opening: this till never sells outside a session.
  ['the register answers none', async () => null],
])('takes no payment when %s', async (_, requireSaleSession) => {
  const sale = { startTender: vi.fn() };
  const pin = vi.fn();
  expect(await startTenderInSession({ requireSaleSession }, sale, 'cash', pin)).toBe(OPEN_REGISTER_TEXT);
  expect(pin).not.toHaveBeenCalled();
  expect(sale.startTender).not.toHaveBeenCalled();
});

it('pins nothing when the session document is missing, and still starts the tender', async () => {
  const session = { id: 'session-1', sessions: { findOne: () => ({ exec: async () => null }) } as RegisterSessionCollection };
  const sale = { startTender: vi.fn() };
  const pin = vi.fn();
  expect(await startTenderInSession({ requireSaleSession: async () => session }, sale, 'cash', pin)).toBeUndefined();
  expect(pin).not.toHaveBeenCalled();
  expect(sale.startTender).toHaveBeenCalledWith('cash', { session });
});
