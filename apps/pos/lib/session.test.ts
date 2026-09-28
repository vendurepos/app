import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_KEY, clearSession, defaultStore, loadSession, saveSession, sessionContext,
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

describe('session storage', () => {
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
