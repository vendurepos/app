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
    const capabilities = await read();
    expect(capabilities).toBeDefined();
    expect(capabilities).toEqual(parseInfoCapabilities(body));
    expect(capabilities).not.toHaveProperty('cashRounding');
  });

  it('C3: a body parseInfoCapabilities cannot read stays undefined, even with cashRounding', async () => {
    const body = { ...INFO, taxRounding: 'odd', cashRounding: { v: 1 } };
    expect(withCashRounding(body, undefined)).toBeUndefined();
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await read()).toBeUndefined();
    expect(original).not.toHaveBeenCalled();
  });

  it("C4a: 404 answers the connector reader's { orderCreate: 1 }, read once, without calling the connector reader", async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
    original.mockResolvedValue({ orderCreate: 11 });
    expect(await read()).toEqual({ orderCreate: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([401, 403])('C4d: %s answers undefined when the connector reader answers undefined, calling it once with the context', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    original.mockResolvedValue(undefined);
    expect(await read()).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith(context);
  });

  it.each([401, 403])('C4d: %s answers undefined even when the connector reader answers a ready read with cashRounding', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    original.mockResolvedValue(parseInfoCapabilities({ ...INFO, cashRounding: { v: 1 } }));
    expect(await read()).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 500', () => Promise.resolve(new Response('oops', { status: 500 }))],
    ['a 302', () => Promise.resolve(new Response('', { status: 302, headers: { Location: '/elsewhere' } }))],
    ['a non-JSON 200', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a fetch that throws', () => Promise.reject(new TypeError('Network request failed'))],
    ['a fetch that aborts', () => Promise.reject(new DOMException('Aborted', 'AbortError'))],
  ])('C4b: %s answers undefined without calling the connector reader', async (_, response) => {
    fetchMock.mockImplementation(response);
    original.mockResolvedValue({ orderCreate: 1 });
    expect(await read()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    ['a JSON array 200', [1]], ['a JSON null 200', null],
  ])('C4c: %s answers parseInfoCapabilities alone, without the connector reader', async (_, body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    original.mockResolvedValue({ orderCreate: 1 });
    const capabilities = await read();
    expect(capabilities).toEqual(parseInfoCapabilities(body));
    expect(capabilities).toBeUndefined();
    expect(original).not.toHaveBeenCalled();
  });

  it('C5: after a read that throws, the next call reads /info once and takes cashRounding', async () => {
    const body = { ...INFO, cashRounding: { v: 1 } };
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce(Response.json(body));
    original.mockResolvedValue(parseInfoCapabilities(body));
    const connector = catalogueConnector(session);
    expect(await connector.capabilities!(context)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await connector.capabilities!(context)).toEqual({ ...parseInfoCapabilities(body), cashRounding: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([401, 403])("C4: the connector reader's sign-out on %s reaches the caller unchanged", async (status) => {
    const signedOut = new ConnectorUnauthorizedError('signed out', 401);
    fetchMock.mockResolvedValue(new Response('', { status }));
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
