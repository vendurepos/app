import { ConnectorUnauthorizedError, parseInfoCapabilities, type ServerCapabilities, type SyncContext } from '@tallyui/core';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogueConnector, withCashRounding } from './catalogue';
import type { Session } from './session';

// The connector's own /info reader, replaced by a spy so a delegated read is seen exactly.
const { original } = vi.hoisted(() => ({ original: vi.fn<(context: SyncContext) => Promise<ServerCapabilities | undefined>>() }));
vi.mock('./storage', () => ({ createStorage: () => getRxStorageMemory() }));
vi.mock('@tallyui/connector-vendure', async (importActual) => {
  const actual = await importActual<typeof import('@tallyui/connector-vendure')>();
  return { ...actual, createVendureConnector: (options: Parameters<typeof actual.createVendureConnector>[0]) => ({ ...actual.createVendureConnector(options), capabilities: original }) };
});

const session: Session = {
  url: 'https://shop.example.com', email: 'till@example.com', token: 'session-token', channelToken: 'channel-token',
  settings: { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 0 } },
  stock: { trackInventory: false, outOfStockThreshold: 0 },
};
const context: SyncContext = { connectorId: 'vendure', baseUrl: 'https://shop.example.com', headers: { Authorization: 'Bearer session-token' }, signal: new AbortController().signal };
const INFO = {
  contracts: { 'order.create': [1, 10, 11], 'order.refund': [1], register: [1] },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
  coupons: true,
};
const fetchMock = vi.fn<typeof fetch>();
const read = () => catalogueConnector(session).capabilities!(context);

beforeEach(() => {
  fetchMock.mockReset();
  original.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('catalogueConnector capabilities (cash rounding)', () => {
  it('C1: /info advertising cashRounding { v: 1 } adds cashRounding: true to parseInfoCapabilities', async () => {
    const body = { ...INFO, cashRounding: { v: 1 } };
    fetchMock.mockResolvedValue(Response.json(body));
    const capabilities = await read();
    expect(capabilities).toEqual({ ...parseInfoCapabilities(body), cashRounding: true });
    expect(capabilities).toMatchObject({ orderCreate: 11, orderRefund: 1, register: 1, coupons: true });
    expect(original).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://shop.example.com/tally/v1/info');
    expect(init).toEqual({ method: 'GET', headers: context.headers, signal: context.signal });
  });

  it('C2: /info without cashRounding is parseInfoCapabilities alone, with no cashRounding key', async () => {
    fetchMock.mockResolvedValue(Response.json(INFO));
    const capabilities = await read();
    expect(capabilities).toEqual(parseInfoCapabilities(INFO));
    expect(capabilities).not.toHaveProperty('cashRounding');
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ['true', true], ['{}', {}], ['{ v: 0 }', { v: 0 }], ["{ v: '1' }", { v: '1' }], ['{ v: 1.5 }', { v: 1.5 }], ['null', null],
  ])('C3: cashRounding %s adds no cashRounding key', async (_, cashRounding) => {
    const body = { ...INFO, cashRounding };
    expect(withCashRounding(body, parseInfoCapabilities(body))).toEqual(parseInfoCapabilities(INFO));
    expect(withCashRounding(body, parseInfoCapabilities(body))).not.toHaveProperty('cashRounding');
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await read()).not.toHaveProperty('cashRounding');
  });

  it('C3: a body parseInfoCapabilities cannot read stays undefined, even with cashRounding', async () => {
    const body = { ...INFO, taxRounding: 'odd', cashRounding: { v: 1 } };
    expect(withCashRounding(body, undefined)).toBeUndefined();
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await read()).toBeUndefined();
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ['401', () => new Response('', { status: 401 })], ['403', () => new Response('', { status: 403 })],
    ['404', () => new Response('Not Found', { status: 404 })], ['500', () => new Response('oops', { status: 500 })],
    ['a non-JSON 200', () => new Response('<html>', { status: 200 })], ['a JSON array 200', () => Response.json([1])],
  ])('C4: %s answers exactly what the connector reader answers', async (_, response) => {
    const sentinel = { orderCreate: 1 } as ServerCapabilities;
    fetchMock.mockImplementation(async () => response());
    original.mockResolvedValue(sentinel);
    expect(await read()).toBe(sentinel);
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith(context);
  });

  it('C4: a fetch that throws, or aborts, answers what the connector reader answers', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    original.mockResolvedValueOnce(undefined);
    expect(await read()).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    original.mockResolvedValueOnce(undefined);
    expect(await read()).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("C4: the connector reader's sign-out on 401 reaches the caller unchanged", async () => {
    const signedOut = new ConnectorUnauthorizedError('signed out', 401);
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    original.mockRejectedValue(signedOut);
    await expect(read()).rejects.toBe(signedOut);
  });

  it('keeps every other connector member as the connector built it', async () => {
    const { createVendureConnector } = await import('@tallyui/connector-vendure');
    const plain = createVendureConnector({});
    const wrapped = catalogueConnector(session);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(plain).sort());
    expect(wrapped.auth).toBe(plain.auth);
    expect(wrapped.capabilities).not.toBe(original);
  });
});
