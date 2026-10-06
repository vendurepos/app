import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_KEY, clearSession, defaultStore, loadSession, saveSession, sessionContext, sessionKey, tillIdentity,
  type KeyValueStore, type Session,
} from './session';

const session: Session = {
  url: 'https://shop.example.com', email: 'cashier@example.com', token: 'test-token',
  settings: { currency: 'GBP', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 2 },
};
let store: KeyValueStore;

beforeEach(() => {
  const data: Record<string, string> = {};
  store = {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('sessionKey ignores the token and follows the store and its settings', () => {
  expect(sessionKey({ ...session, token: 'new-token' })).toBe(sessionKey(session));
  expect(sessionKey({ ...session, channelToken: 'channel-1' })).not.toBe(sessionKey(session));
  expect(sessionKey({ ...session, barcodeField: 'barcode' })).not.toBe(sessionKey(session));
  expect(sessionKey({ ...session, settings: { ...session.settings, pricesIncludeTax: false } })).not.toBe(sessionKey(session));
});

describe('session storage', () => {
  it('round trips a device-key session', () => {
    const device = { ...session, kind: 'api-key' as const, apiKey: 'test-device-key', device: 'Front counter iPad', email: '', token: '' };
    saveSession(device, store);
    expect(loadSession(store)).toEqual(device);
  });

  it('round trips the barcode field', () => {
    const withBarcode = { ...session, barcodeField: 'barcode' };
    saveSession(withBarcode, store);
    expect(loadSession(store)).toEqual(withBarcode);
  });

  it('saves exactly the session and loads it', () => {
    saveSession(session, store);
    expect(store.getItem(SESSION_KEY)).toBe(JSON.stringify(session));
    expect(loadSession(store)).toEqual(session);
  });

  it('returns null for a missing session', () => {
    expect(loadSession(store)).toBeNull();
  });

  it.each([
    '{', 'null', '[]', '{}', '"text"',
    JSON.stringify({ ...session, barcodeField: 123 }),
    JSON.stringify({ ...session, barcodeField: 'bad name' }),
    ...[undefined, '', 123].map((apiKey) => JSON.stringify({ ...session, kind: 'api-key', apiKey })),
    JSON.stringify({ ...session, kind: 'other' }),
    JSON.stringify({ ...session, device: 123 }),
    ...['url', 'email', 'token'].map((key) => JSON.stringify({ ...session, [key]: 1 })),
    ...['settings', 'stock'].flatMap((key) =>
      [undefined, null, 'bad', []].map((value) => JSON.stringify({ ...session, [key]: value }))),
  ])('returns null for invalid stored data %s', (value) => {
    store.setItem(SESSION_KEY, value);
    expect(loadSession(store)).toBeNull();
  });

  it('returns null when reading throws', () => {
    store.getItem = () => { throw new Error('Storage denied'); };
    expect(loadSession(store)).toBeNull();
  });

  it('clears the session', () => {
    saveSession(session, store);
    clearSession(store);
    expect(store.getItem(SESSION_KEY)).toBeNull();
  });

  it('uses available localStorage by default', () => {
    vi.stubGlobal('localStorage', store);
    expect(defaultStore()).toBe(store);
    saveSession(session);
    expect(loadSession()).toEqual(session);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it.each(['missing', 'throwing'])('shares in-memory storage when localStorage is %s', (mode) => {
    if (mode === 'throwing') store.getItem = () => { throw new Error('Storage denied'); };
    vi.stubGlobal('localStorage', mode === 'missing' ? undefined : store);
    expect(defaultStore()).toBe(defaultStore());
    saveSession(session);
    expect(loadSession()).toEqual(session);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it.each([undefined, '', 'channel-1'])('builds the context with channel %s', (channelToken) => {
    expect(sessionContext({ ...session, channelToken })).toEqual({
      connectorId: 'vendure', baseUrl: session.url,
      headers: {
        Authorization: 'Bearer test-token',
        ...(channelToken ? { 'vendure-token': channelToken } : {}),
      },
    });
  });
});

it('sends device-key and channel headers without a bearer token', () => {
  expect(sessionContext({ ...session, kind: 'api-key', apiKey: 'test-device-key', channelToken: 'channel-1' }).headers).toEqual({
    'vendure-api-key': 'test-device-key', 'vendure-token': 'channel-1',
  });
});

it('uses the device name or fallback for devices and email for password sessions', () => {
  expect(tillIdentity({ ...session, kind: 'api-key', device: 'Front counter iPad' })).toBe('Front counter iPad');
  expect(tillIdentity({ ...session, kind: 'api-key' })).toBe('Device key');
  expect(tillIdentity({ ...session, kind: 'api-key', device: '' })).toBe('Device key');
  expect(tillIdentity(session)).toBe(session.email);
  expect(tillIdentity({ ...session, kind: 'password' })).toBe(session.email);
});
