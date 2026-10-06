import { vendureAuth } from '@tallyui/connector-vendure';
import type { StoreSettings, SyncContext } from '@tallyui/core';
import { isFieldName } from './barcode-field';

export interface Session {
  /** Server root, as returned by normalizeStoreUrl. */
  url: string;
  /** vendure-token of the channel; absent means the default channel. */
  channelToken?: string;
  barcodeField?: string;
  email: string;
  token: string;
  settings: StoreSettings;
  stock: { trackInventory: boolean; outOfStockThreshold: number };
}

/** What a sale depends on besides the token: the store, channel, barcode field and the settings read at sign-in. A new token for the same key keeps the sale. */
export function sessionKey(session: Session): string {
  return JSON.stringify([session.url, session.channelToken ?? '', session.barcodeField ?? '', session.settings, session.stock]);
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// localStorage key for the signed-in session; never contains the password.
export const SESSION_KEY = 'vendurepos.session';

const memory = new Map<string, string>();
const memoryStore: KeyValueStore = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value); },
  removeItem: (key) => { memory.delete(key); },
};

export function defaultStore(): KeyValueStore {
  try {
    const store = globalThis.localStorage;
    if (store) {
      store.getItem(SESSION_KEY);
      return store;
    }
  } catch {
    // Native or restricted browser storage uses the shared process-local Map.
  }
  return memoryStore;
}

export function loadSession(store: KeyValueStore = defaultStore()): Session | null {
  try {
    const session = JSON.parse(store.getItem(SESSION_KEY) ?? 'null');
    if (!session || typeof session.url !== 'string' || typeof session.email !== 'string' ||
      typeof session.token !== 'string' ||
      (session.barcodeField !== undefined && (typeof session.barcodeField !== 'string' || !isFieldName(session.barcodeField))) ||
      !session.settings || typeof session.settings !== 'object' || Array.isArray(session.settings) ||
      !session.stock || typeof session.stock !== 'object' || Array.isArray(session.stock)) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, store: KeyValueStore = defaultStore()): void {
  store.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(store: KeyValueStore = defaultStore()): void {
  store.removeItem(SESSION_KEY);
}

export function sessionContext(session: Session): SyncContext {
  return {
    connectorId: 'vendure',
    baseUrl: session.url,
    headers: vendureAuth.getHeaders({
      token: session.token,
      ...(session.channelToken ? { channel_token: session.channelToken } : {}),
    }),
  };
}

/** FNV-1a of a store key as 8 hex digits: a stable, filesystem-safe database name part that never holds the key. */
export function storeKeyHash(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
