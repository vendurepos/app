import { expect, it } from 'vitest';
import {
  DISPLAY_ADVERTISEMENT, DISPLAY_STORE_KEY, DISPLAY_TOKEN_KEY, displayTokenStore, forgetDisplayStore, loadDisplayStore,
  submitDisplayStore,
} from './display-store';
import type { KeyValueStore } from './session';
import { normalizeStoreUrl } from './store-url';

const memoryStorage = () => {
  const stored = new Map<string, string>();
  const storage: KeyValueStore = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: (key) => { stored.delete(key); },
  };
  return { storage, stored };
};

it('(a) advertises no ICE servers and reads the snapshot', () => {
  expect(DISPLAY_ADVERTISEMENT).toStrictEqual({ iceServers: [], snapshot: true });
});

it('(b) saves the normalized store URL', () => {
  const { storage } = memoryStorage();
  expect(submitDisplayStore('  https://shop.example.com/admin-api/ ', storage, 'https:')).toEqual({ ok: true, url: 'https://shop.example.com' });
  expect(loadDisplayStore(storage)).toBe('https://shop.example.com');
});

it("(c) refuses a public http:// URL or garbage with sign-in's error and saves nothing", () => {
  const { storage, stored } = memoryStorage();
  for (const input of ['http://shop.example.com', 'not a url']) {
    expect(submitDisplayStore(input, storage, 'http:')).toEqual(normalizeStoreUrl(input, 'http:'));
    expect(submitDisplayStore(input, storage, 'http:').ok).toBe(false);
  }
  expect(stored.size).toBe(0);
  submitDisplayStore('https://saved.example.com', storage, 'https:');
  storage.setItem(DISPLAY_TOKEN_KEY, 'token-1');
  expect(submitDisplayStore('http://shop.example.com', storage, 'https:').ok).toBe(false);
  expect(loadDisplayStore(storage)).toBe('https://saved.example.com');
  expect(storage.getItem(DISPLAY_TOKEN_KEY)).toBe('token-1');
});

it('(d) a different store removes the token; the same store keeps it', () => {
  const { storage } = memoryStorage();
  submitDisplayStore('https://a.example.com', storage, 'https:');
  storage.setItem(DISPLAY_TOKEN_KEY, 'token-a');
  submitDisplayStore('https://a.example.com/', storage, 'https:');
  expect(storage.getItem(DISPLAY_TOKEN_KEY)).toBe('token-a');
  submitDisplayStore('https://b.example.com', storage, 'https:');
  expect(loadDisplayStore(storage)).toBe('https://b.example.com');
  expect(storage.getItem(DISPLAY_TOKEN_KEY)).toBeNull();
});

it('(e) the token store loads, saves and clears only the token key', async () => {
  const { storage, stored } = memoryStorage();
  storage.setItem(DISPLAY_STORE_KEY, 'https://a.example.com');
  const tokens = displayTokenStore(storage);
  expect(await tokens.load()).toBeNull();
  await tokens.save('token-1');
  expect(await tokens.load()).toBe('token-1');
  expect([...stored.keys()].sort()).toEqual([DISPLAY_STORE_KEY, DISPLAY_TOKEN_KEY].sort());
  await tokens.clear();
  expect(await tokens.load()).toBeNull();
  expect([...stored.entries()]).toEqual([[DISPLAY_STORE_KEY, 'https://a.example.com']]);
});

it('(f) forgetting the store removes the store and the token', () => {
  const { storage, stored } = memoryStorage();
  submitDisplayStore('https://a.example.com', storage, 'https:');
  storage.setItem(DISPLAY_TOKEN_KEY, 'token-a');
  forgetDisplayStore(storage);
  expect(stored.size).toBe(0);
});
