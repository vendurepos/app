import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_CUSTOMER_KEY, loadDefaultCustomer, saveDefaultCustomer } from './default-customer';
import type { KeyValueStore } from './session';

const session = { url: 'https://store.example' };
const customer = { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' };
let store: KeyValueStore;
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('returns null when nothing is stored', () => {
  expect(loadDefaultCustomer(session, store)).toBeNull();
});

it.each([customer, { id: '1', name: 'Ada Lovelace' }])('round-trips a customer %j', (value) => {
  saveDefaultCustomer(session, value, store);
  expect(loadDefaultCustomer(session, store)).toEqual(value);
});

it.each([
  { url: 'https://other-store.example' },
  { url: session.url, channelToken: 'other-channel' },
])('keeps the default separate for %j', (otherSession) => {
  const otherCustomer = { id: '2', name: 'Grace Hopper' };
  saveDefaultCustomer(session, customer, store);
  expect(loadDefaultCustomer(otherSession, store)).toBeNull();
  saveDefaultCustomer(otherSession, otherCustomer, store);
  expect(loadDefaultCustomer(session, store)).toEqual(customer);
  expect(loadDefaultCustomer(otherSession, store)).toEqual(otherCustomer);
});

it.each(['invalid JSON', JSON.stringify({ id: '1' })])('returns null for %s', (value) => {
  store.setItem(`${DEFAULT_CUSTOMER_KEY}:${session.url}|`, value);
  expect(loadDefaultCustomer(session, store)).toBeNull();
});

it('saving null removes the default', () => {
  saveDefaultCustomer(session, customer, store);
  saveDefaultCustomer(session, null, store);
  expect(store.getItem(`${DEFAULT_CUSTOMER_KEY}:${session.url}|`)).toBeNull();
  expect(loadDefaultCustomer(session, store)).toBeNull();
});
