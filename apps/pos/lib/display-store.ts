import type { DisplayAdvertisement } from '@tallyui/core';
import type { DisplayTokenStore } from '@tallyui/pos';
import type { KeyValueStore } from './session';
import { normalizeStoreUrl, type StoreUrlResult } from './store-url';

// localStorage key for the store a customer display pairs with, as normalizeStoreUrl returns it.
export const DISPLAY_STORE_KEY = 'vendurepos.display_store';
// localStorage key for the display's token; it belongs to the store under DISPLAY_STORE_KEY.
export const DISPLAY_TOKEN_KEY = 'vendurepos.display_token';

// Fixed by the Front desk ruling (2026-11-18): a display has no session, and the plugin advertises ICE only to a
// signed-in till, so the display offers no ICE servers of its own and reads the snapshot fallback.
export const DISPLAY_ADVERTISEMENT: DisplayAdvertisement = { iceServers: [], snapshot: true };

export function loadDisplayStore(storage: KeyValueStore): string | null {
  return storage.getItem(DISPLAY_STORE_KEY);
}

/** Validates `input` as sign-in does and saves it when it passes; a different store drops the old store's token. */
export function submitDisplayStore(input: string, storage: KeyValueStore, pageProtocol?: string): StoreUrlResult {
  // An undefined pageProtocol takes normalizeStoreUrl's default, the page's own protocol.
  const result = normalizeStoreUrl(input, pageProtocol);
  if (!result.ok) return result;
  if (loadDisplayStore(storage) !== result.url) storage.removeItem(DISPLAY_TOKEN_KEY);
  storage.setItem(DISPLAY_STORE_KEY, result.url);
  return result;
}

export function forgetDisplayStore(storage: KeyValueStore): void {
  storage.removeItem(DISPLAY_STORE_KEY);
  storage.removeItem(DISPLAY_TOKEN_KEY);
}

export function displayTokenStore(storage: KeyValueStore): DisplayTokenStore {
  return {
    load: async () => storage.getItem(DISPLAY_TOKEN_KEY),
    save: async (token) => { storage.setItem(DISPLAY_TOKEN_KEY, token); },
    clear: async () => { storage.removeItem(DISPLAY_TOKEN_KEY); },
  };
}
