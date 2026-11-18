import type { DisplayAdvertisement, DisplayRecord, DisplaySignalling, ServerCapabilities } from '@tallyui/core';
import { decodeDisplayMessage, encodeDisplayMessage, makeEnvelope, type TillDisplayServiceOptions } from '@tallyui/pos';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AFTER_COMPLETE_MS, createTillCustomerDisplay, customerDisplayAdvertisement, displayConfig, type TillCustomerDisplay,
} from './customer-display';
import { DEMO_STORE_ORIGIN } from './demo/fetch';
import { sessionContext, type KeyValueStore, type Session } from './session';
import { deviceId, displayDeviceId } from './till-ids';

// The service's options, so (d) can reach configFor: the service sends a config only over a peer link or a snapshot.
const recorded = vi.hoisted(() => ({ service: [] as TillDisplayServiceOptions[] }));
vi.mock('@tallyui/pos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tallyui/pos')>();
  return {
    ...actual,
    createTillDisplayService: (options: TillDisplayServiceOptions) => {
      recorded.service.push(options);
      return actual.createTillDisplayService(options);
    },
  };
});

const session: Session = {
  url: 'https://store.test', channelToken: 'channel-a', email: 'cashier@example.com', token: 'session-token',
  settings: { currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 0 },
};
const record: DisplayRecord = { displayId: 'display-1', name: 'Counter', cashierId: '1', lastSeenAt: null, connected: false };
const advertisement: DisplayAdvertisement = { iceServers: [], snapshot: true };
const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();

const memoryStorage = (): KeyValueStore => {
  const stored = new Map<string, string>();
  return { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); }, removeItem: (key) => { stored.delete(key); } };
};
const fakeSignalling = () => ({
  mint: vi.fn(async () => ({ code: '123456', expiresAt: new Date(Date.now() + 600_000).toISOString() })),
  pending: vi.fn(async () => []), confirm: vi.fn(async () => {}), decline: vi.fn(async () => {}),
  list: vi.fn(async () => []), forget: vi.fn(async () => {}), sendSignal: vi.fn(async () => {}),
  receiveSignals: vi.fn(async () => []), postSnapshot: vi.fn(async () => {}),
  claim: vi.fn(async () => ({ claimSecret: 'secret', checkCode: '1234' })),
  collect: vi.fn(async () => ({ status: 'pending' as const, checkCode: '1234' })),
  displaySendSignal: vi.fn(async () => {}), displayReceiveSignals: vi.fn(async () => []), readSnapshot: vi.fn(async () => null),
}) satisfies DisplaySignalling;

const open: TillCustomerDisplay[] = [];
const start = (current: () => Session = () => session) => {
  const signalling = fakeSignalling();
  const storage = memoryStorage();
  const handles = createTillCustomerDisplay({ session: current, advertisement, signalling, storage });
  open.push(handles);
  return { handles, signalling, storage };
};
afterEach(() => {
  open.splice(0).forEach((handles) => handles.close());
  recorded.service.length = 0;
});

it('(a) gives the display its record, this store and channel, and the idle hold, and the config decodes', () => {
  const store = { name: 'https://store.test', currency: 'EUR', locale, timezone: timeZone };
  const rest = { presentation_hints: {}, i18n: {}, idle: { afterCompleteMs: AFTER_COMPLETE_MS } };
  const withChannel = displayConfig(session, record);
  expect(withChannel).toEqual({
    contract: '1.0', display: { id: 'display-1', name: 'Counter' }, store: { id: 'https://store.test#channel-a', ...store }, ...rest,
  });
  expect(displayConfig({ ...session, channelToken: undefined }, record)).toEqual({
    contract: '1.0', display: { id: 'display-1', name: 'Counter' }, store: { id: 'https://store.test', ...store }, ...rest,
  });
  expect(decodeDisplayMessage(encodeDisplayMessage(makeEnvelope('display.config', withChannel)))).toMatchObject({ ok: true });
});

it("(b) takes the store's advertisement, and none from a store without one or from the demo store", () => {
  const capabilities = { orderCreate: 5, customerDisplay: advertisement } as ServerCapabilities;
  expect(customerDisplayAdvertisement(session, capabilities)).toEqual(advertisement);
  expect(customerDisplayAdvertisement(session, { orderCreate: 5 } as ServerCapabilities)).toBeNull();
  expect(customerDisplayAdvertisement(session)).toBeNull();
  expect(customerDisplayAdvertisement({ ...session, url: DEMO_STORE_ORIGIN }, capabilities)).toBeNull();
});

it("(c) mints a code with the session's headers and the display device id, never the register id", async () => {
  const { handles, signalling, storage } = start();
  await handles.pairing.start();
  expect(handles.pairing.phase).toMatchObject({ phase: 'code', code: '123456' });
  expect(signalling.mint).toHaveBeenCalledTimes(1);
  const [ctx, sentId] = signalling.mint.mock.calls[0] as unknown as Parameters<DisplaySignalling['mint']>;
  expect(ctx.headers).toEqual(sessionContext(session).headers);
  expect(sentId).toBe(displayDeviceId(storage));
  expect(sentId).not.toBe(deviceId(storage));
});

it("(d) configFor reads the session getter's current session", () => {
  let current = session;
  start(() => current);
  const [{ configFor }] = recorded.service;
  expect(configFor(record).store.name).toBe('https://store.test');
  current = { ...session, url: 'https://other.test' };
  expect(configFor(record).store).toMatchObject({ id: 'https://other.test#channel-a', name: 'https://other.test' });
});

it('(e) close() closes the service and the pairing: a later start makes no call', async () => {
  const { handles, signalling } = start();
  handles.close();
  expect(handles.service.status).toBe('closed');
  await new Promise((resolve) => setTimeout(resolve, 0));
  Object.values(signalling).forEach((fn) => fn.mockClear());
  await handles.pairing.start();
  expect(handles.pairing.phase).toEqual({ phase: 'idle' });
  for (const fn of Object.values(signalling)) expect(fn).not.toHaveBeenCalled();
});
