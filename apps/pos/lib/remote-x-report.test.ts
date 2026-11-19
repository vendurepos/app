import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_ENDED_TEXT } from './catalogue-status';
import {
  cashMovementsFromRead, REGISTER_CLOSED_TEXT, remoteXReport, STORE_UNREACHABLE_TEXT, xReportOffered, type MovementRead,
} from './remote-x-report';
import type { Session } from './session';

const session: Session = {
  url: 'http://127.0.0.1:3200', email: 'cashier@example.com', token: 'token-1',
  settings: { currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 190000 } },
  stock: { trackInventory: true, outOfStockThreshold: 0 },
};
const movement = (over: Partial<MovementRead> & Pick<MovementRead, 'id'>): MovementRead => ({
  type: 'paid_in', amountMinor: 0, reason: null, voids: null, createdAt: '2026-09-30T09:00:00.000Z', createdBy: 'cashier@example.com', ...over,
});
// The plugin's live session: a paid in of 5.00, a paid out of 2.00 and a paid in of 3.00 the plugin's void row reverses.
const movements = [
  movement({ id: 'm-1', amountMinor: 500, reason: 'float' }),
  movement({ id: 'm-2', type: 'paid_out', amountMinor: 200, reason: 'milk' }),
  movement({ id: 'm-3', amountMinor: 300, reason: 'tip' }),
  movement({ id: 'm-4', type: 'void', voids: 'm-3' }),
];
const live = {
  id: 'session-2', status: 'open', openedAt: '2026-09-30T07:00:00.000Z', openedBy: 'other@example.com', deviceId: 'device-2', deviceName: 'Front',
  countedFloatMinor: 10000, expected: { cash: 10300 }, salesCount: 2, paidInMinor: 500, paidOutMinor: 200, movements,
};
const context = { store: 'Shop', currency: 'EUR', timezone: 'UTC', blind: false, printedAt: '2026-09-30T12:00:00.000Z' };
const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

it("prints another register's live session with the plugin's void as the till's", async () => {
  const fetch = answer(200, { session: live, closures: { items: [] } });
  vi.stubGlobal('fetch', fetch);
  const result = await remoteXReport(session, 'drawer-2', context);
  expect(result).toMatchObject({ sessionId: 'session-2' });
  const lines = 'lines' in result ? result.lines : [];
  expect(lines).toEqual(expect.arrayContaining([
    'X report · Register open', 'Sales 2', 'Opening float €100.00',
    'Paid in €5.00 float', 'Paid out €2.00 milk', 'Paid in €3.00 tip (voided)', 'Void €3.00 tip',
  ]));
  expect(lines.some((line) => line.endsWith('expected €103.00'))).toBe(true);
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/tally\/v1\/registers\/drawer-2\?take=1$/);
});

it('prints no expected figures while the count is blind', async () => {
  vi.stubGlobal('fetch', answer(200, { session: live, closures: { items: [] } }));
  const result = await remoteXReport(session, 'drawer-2', { ...context, blind: true });
  const lines = 'lines' in result ? result.lines : ['missing'];
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((line) => line.includes('expected'))).toEqual([]);
});

it.each([
  ['a rejected fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }), { notice: STORE_UNREACHABLE_TEXT, retry: true, refresh: false }],
  ['401', answer(401), { notice: SESSION_ENDED_TEXT, retry: false, refresh: false }],
  ['403', answer(403), { notice: SESSION_ENDED_TEXT, retry: false, refresh: false }],
  ['404', answer(404), { notice: REGISTER_CLOSED_TEXT, retry: false, refresh: true }],
  ['500', answer(500), { notice: STORE_UNREACHABLE_TEXT, retry: true, refresh: false }],
  ['no live session', answer(200, { session: null, closures: { items: [] } }), { notice: REGISTER_CLOSED_TEXT, retry: false, refresh: true }],
  ['a counting session', answer(200, { session: { ...live, status: 'counting' }, closures: { items: [] } }), { notice: null, retry: false, refresh: true }],
  ['an older plugin without movements', answer(200, { session: { ...live, movements: undefined }, closures: { items: [] } }),
    { notice: null, retry: false, refresh: true }],
])('answers %s with its notice', async (_name, fetch, expected) => {
  vi.stubGlobal('fetch', fetch);
  expect(await remoteXReport(session, 'drawer-2', context)).toEqual(expected);
});

it('keeps a void whose target is not in the read at its own amount and no reason', () => {
  expect(cashMovementsFromRead('session-2', [movement({ id: 'm-9', type: 'void', voids: 'm-elsewhere' })])).toEqual([{
    id: 'm-9', session_id: 'session-2', type: 'void', amountMinor: 0, reason: '', created_at_gmt: '2026-09-30T09:00:00.000Z',
    created_by: 'cashier@example.com', voids: 'm-elsewhere', voided_by: null,
  }]);
});

it("offers the X report only for another register's open, printable session", () => {
  const options = { ownRegisterId: 'drawer-1', status: 'open' as const, printable: ['drawer-1', 'drawer-2'] };
  expect(xReportOffered('drawer-2', options)).toBe(true);
  expect(xReportOffered('drawer-1', options)).toBe(false);
  expect(xReportOffered('drawer-2', { ...options, status: 'counting' })).toBe(false);
  expect(xReportOffered('drawer-3', options)).toBe(false);
});
