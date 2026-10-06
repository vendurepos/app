import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVendureConnector, createVendureVariantFeedReplication } from '@tallyui/connector-vendure';
import { isCommandBatchResponse, type AnyCommandEnvelope, type CommandEnvelope, type OrderCreatePayload, type RegisterCommandEnvelope } from '@tallyui/core';
import { parseCommandResult } from '@tallyui/core/server';
import { signIn } from '../sign-in';
import { sessionContext, type Session } from '../session';
import { orderTransport } from '../order-transport';
import { readCapabilities } from '../use-sale-settings';
import { logout } from '../logout';
import { barcodeOf, CATALOGUE } from './catalogue';
import { DEMO_CHANNEL_TOKEN, DEMO_CREDENTIALS, DEMO_STORE_ORIGIN, installDemoStore } from './fetch';
import { DEMO_INFO, DEMO_STORAGE_KEY, DemoStore, type DemoStorage } from './store';

// A valid client timestamp shared by the test's order and register commands.
const TIME = '2026-10-01T10:00:00.000Z';
// Two tax-exclusive mugs: EUR 16.00 net plus EUR 3.04 German standard tax.
const ORDER: CommandEnvelope<OrderCreatePayload> = {
  id: 'order-command', type: 'order.create', version: 4, createdAt: TIME, deviceId: 'till', attempt: 1,
  payload: {
    clientOrderId: 'order', createdAt: TIME, currency: 'EUR', pricesIncludeTax: false, sessionId: 'session', registerId: 'register',
    lines: [{ clientLineId: 'line', variantId: '1', title: 'Tally Fixture Mug', quantity: 2, unitPriceMinor: 800 }],
    subtotalMinor: 1600, taxMinor: 304, totalMinor: 1904,
    payments: [{ clientPaymentId: 'payment', method: 'cash', amountMinor: 1904, tenderedMinor: 2000, changeMinor: 96 }],
    display: { currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor: 1600, discountMinor: 0,
      taxMinor: 304, totalMinor: 1904, orderDiscountMinor: 0, lines: [{ clientLineId: 'line', amountMinor: 1600, discounts: [] }] },
    taxByRate: [{ ratePpm: 190000, code: 'Standard DE', netMinor: 1600, taxMinor: 304, grossMinor: 1904 }],
  },
};
const V5_ORDER: CommandEnvelope<OrderCreatePayload> = {
  ...ORDER, version: 5,
  payload: {
    ...ORDER.payload,
    lines: [...ORDER.payload.lines, { clientLineId: 'custom', custom: { name: 'Gift wrapping', taxStatus: 'taxable' }, quantity: 3, unitPriceMinor: 300 }],
    fees: [{ clientFeeId: 'fee', name: 'Handling', amountMinor: 100, taxStatus: 'taxable', taxMinor: 19 }],
    shipping: [{ clientShippingId: 'shipping', name: 'Delivery', amountMinor: 200, taxStatus: 'taxable', taxMinor: 38 }],
    subtotalMinor: 2800, taxMinor: 532, totalMinor: 3332,
    payments: [{ clientPaymentId: 'payment', method: 'cash', amountMinor: 3332 }],
    display: { ...ORDER.payload.display!, subtotalMinor: 2800, taxMinor: 532, totalMinor: 3332,
      lines: [...ORDER.payload.display!.lines, { clientLineId: 'custom', amountMinor: 900, discounts: [] }] },
    taxByRate: [{ ratePpm: 190000, code: 'Standard DE', netMinor: 2800, taxMinor: 532, grossMinor: 3332 }],
  },
};

let values: Map<string, string>;
let storage: DemoStorage;
let installed: ReturnType<typeof installDemoStore>;
let original: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  values = new Map();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  original = vi.fn<typeof fetch>(async () => new Response('outside'));
  vi.stubGlobal('fetch', original);
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
});
afterEach(() => { installed.uninstall(); vi.unstubAllGlobals(); });

async function signedIn(): Promise<Session> {
  const outcome = await signIn({ url: DEMO_STORE_ORIGIN, ...DEMO_CREDENTIALS, channel_token: DEMO_CHANNEL_TOKEN, barcode_field: 'barcode' });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.session;
}

async function send(session: Session, ...batch: AnyCommandEnvelope[]) {
  const outcome = await orderTransport(session).send(batch);
  expect(outcome.kind).toBe('results');
  if (outcome.kind !== 'results') throw new Error(outcome.kind);
  expect(isCommandBatchResponse(outcome)).toBe(true);
  for (const result of outcome.results) expect(parseCommandResult(result)).toEqual(result);
  return outcome.results;
}

function register(type: RegisterCommandEnvelope['type'], id: string, payload: Record<string, unknown>): RegisterCommandEnvelope {
  return { id, type, version: 1, payload, createdAt: TIME, deviceId: 'till', attempt: 1 };
}

async function mugStock(session: Session) {
  for await (const page of createVendureConnector().reconcile!.stock!.fetchPages(sessionContext(session))) {
    const levels = page.get(ORDER.payload.lines[0].variantId!) as { stockOnHand: number }[] | undefined; // The fixture's mug line always has a variant.
    if (levels) return levels.reduce((sum, level) => sum + level.stockOnHand, 0);
  }
  throw new Error('Mug missing from stock query');
}

it('signs in the public demo cashier and rejects the old demo credentials', async () => {
  expect(await signIn({ url: DEMO_STORE_ORIGIN, email: 'cashier@demo.vendurepos.com', password: 'demo1234' }))
    .toMatchObject({ ok: true, session: { email: 'cashier@demo.vendurepos.com' } });
  expect(await signIn({ url: DEMO_STORE_ORIGIN, email: 'demo@vendurepos.com', password: 'demo' }))
    .toEqual({ ok: false, error: 'Email or password is incorrect.' });
});

it('signs in through the app, checks the barcode field and reads the seeded tax settings', async () => {
  const session = await signedIn();
  expect(session.token).toBeTruthy();
  expect(session.settings).toEqual({ currency: 'EUR', pricesIncludeTax: false,
    taxRatesPpm: { default: 190000, '1': 190000, '2': 70000 },
    taxRateCodes: { default: 'Standard DE', '1': 'Standard DE', '2': 'Reduced DE' } });
  expect(session.stock).toEqual({ trackInventory: true, outOfStockThreshold: 0 });
  expect(await signIn({ url: DEMO_STORE_ORIGIN, ...DEMO_CREDENTIALS, password: 'wrong' }))
    .toEqual({ ok: false, error: 'Email or password is incorrect.' });
  expect(await logout(session)).toBe('ok');
  expect(original).not.toHaveBeenCalled();
});

it('reads the plugin versions and tax rounding through the app and real connector', async () => {
  expect(DEMO_INFO).toMatchObject({ contracts: { 'order.create': [1, 2, 3, 4, 5] }, maxShippingLines: 1, lineTax: { none: true, classes: true } });
  expect(await readCapabilities(await signedIn(), createVendureConnector())).toEqual({
    orderCreate: 5, register: 1, taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
    lineTax: { none: true, classes: true },
  });
});

it('pulls the whole catalogue with paginated replication and honours its checkpoints', async () => {
  const context = sessionContext(await signedIn());
  const connector = createVendureConnector({ barcodeField: 'barcode' });
  const pull = connector.replication!.products!.pull;
  const products: any[] = [];
  let checkpoint;
  for (let pass = 0; pass < 4; pass++) {
    const result = await pull.handler(checkpoint, 3, context);
    products.push(...result.documents);
    checkpoint = result.checkpoint;
  }
  expect(products).toHaveLength(10);
  expect(products.flatMap(product => product.variants)).toHaveLength(21);
  expect(new Set(products.map(product => product.id)).size).toBe(10);
  expect(products[0].variants[0]).toMatchObject({ sku: 'TALLY-MUG', price: 800, priceWithTax: 952, customFields: { barcode: barcodeOf(0) } });
  expect(connector.traits.product!.getVariants!(products[0])[0].barcode).toBe(barcodeOf(0));
  expect(connector.traits.product!.getStock(products[0]).quantity).toBe(CATALOGUE[0].variants[0].shopFloorStock);
  expect(connector.traits.product!.getStock(products.at(-1))).toEqual({ status: 'in_stock' });
  expect((await pull.handler(checkpoint, 3, context)).documents).toEqual([]);
  const ids = [];
  for await (const page of connector.reconcile!.ids!.fetchPages(context)) ids.push(...page);
  expect(ids).toEqual(products.map(product => ({ id: product.id, variantIds: product.variants.map((variant: any) => variant.id) })));
  for await (const page of connector.reconcile!.prices!.fetchPages(context)) {
    expect([...page]).toEqual(products.map(product => [product.id, connector.reconcile!.prices!.fingerprint(product)]));
  }
  const sync = connector.sync!.products!;
  expect(await sync.fetchAllIds(context)).toHaveLength(10);
  expect((await sync.fetchByIds(['1', '10'], context)).map(product => product.id)).toEqual(['1', '10']);
  expect(await sync.fetchModifiedAfter!('2000-01-01T00:00:00.000Z', context)).toHaveLength(10);
  expect(await sync.fetchModifiedAfter!('2099-01-01T00:00:00.000Z', context)).toEqual([]);
});

it('applies and replays v4 orders through orderTransport, persists them, and updates stock and variant reads', async () => {
  const session = await signedIn();
  const context = sessionContext(session);
  const feed = createVendureVariantFeedReplication('barcode', 0, 3).pull;
  const checkpoint = await feed.seedCheckpoint!(context);
  const before = await mugStock(session);
  const [applied] = await send(session, ORDER);
  expect(applied).toMatchObject({ status: 'applied', serverRefs: { orderId: expect.any(String), displayId: expect.any(String), totalMinor: 1904 } });
  expect(await send(session, ORDER)).toEqual([{ ...applied, status: 'duplicate' }]);
  expect((await send(session, { ...ORDER, payload: { ...ORDER.payload, totalMinor: 1905 } }))[0].error?.code).toBe('idempotency_mismatch');
  expect(await mugStock(session)).toBe(before - 2);
  const changed = await feed.handler(checkpoint, 100, context);
  expect(changed.documents.find(product => product.id === '1').variants[0].stockLevels[0].stockOnHand).toBe(before - 2);
  expect((await feed.handler(changed.checkpoint, 100, context)).documents).toEqual([]);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toEqual([ORDER.payload]);
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect(await send(session, { ...ORDER, attempt: 2, payload: Object.fromEntries(Object.entries(ORDER.payload).reverse()) as unknown as OrderCreatePayload }))
    .toEqual([{ ...applied, status: 'duplicate' }]);
  expect(await mugStock(session)).toBe(before - 2);
  expect([...values.keys()]).toEqual([DEMO_STORAGE_KEY]);
});

it('applies v5 charges and custom lines once, decrementing only the mug stock', async () => {
  const session = await signedIn();
  const before = await mugStock(session);
  const [applied] = await send(session, V5_ORDER);
  expect(applied).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 3332 } });
  expect(await mugStock(session)).toBe(before - 2);
  expect(await send(session, V5_ORDER)).toEqual([{ ...applied, status: 'duplicate' }]);
  expect(await mugStock(session)).toBe(before - 2);
  const state = JSON.parse(values.get(DEMO_STORAGE_KEY)!);
  expect(state.orders).toEqual([V5_ORDER.payload]);
  expect(state.stock).not.toHaveProperty('undefined');
});

it('refuses a second shipping charge before checking tax classes and records the refusal', async () => {
  const session = await signedIn();
  const command = { ...V5_ORDER, payload: { ...V5_ORDER.payload,
    shipping: [...V5_ORDER.payload.shipping!, { ...V5_ORDER.payload.shipping![0], clientShippingId: 'second' }],
    fees: [{ ...V5_ORDER.payload.fees![0], taxClass: 'Luxury' }],
  } };
  const [result] = await send(session, command);
  expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
    message: 'shipping[1]: shipping_single: this store takes one shipping charge per order' } });
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).ledger[command.id].result).toEqual(result);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toEqual([]);
  expect(await mugStock(session)).toBe(CATALOGUE[0].variants[0].shopFloorStock);
  expect(await send(session, command)).toEqual([result]);
});

it.each(['fees', 'shipping', 'lines'] as const)('refuses unknown tax classes on %s with the path and replays the refusal', async field => {
  const session = await signedIn();
  const payload = { ...V5_ORDER.payload, [field]: field === 'lines'
    ? [{ ...V5_ORDER.payload.lines[1], custom: { ...V5_ORDER.payload.lines[1].custom!, taxClass: 'Luxury' } }]
    : V5_ORDER.payload[field]!.map(charge => ({ ...charge, taxClass: 'Luxury' })) };
  const command = { ...V5_ORDER, payload };
  const path = `${field}[0]${field === 'lines' ? '.custom' : ''}.taxClass`;
  const [result] = await send(session, command);
  expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
    message: `${path}: tax_class_unknown: no tax category "Luxury" in this store`, data: { reason: 'tax_class_unknown', path } } });
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toEqual([]);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).ledger[command.id].result).toEqual(result);
  expect(await mugStock(session)).toBe(CATALOGUE[0].variants[0].shopFloorStock);
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect(await send(session, command)).toEqual([result]);
});

it.each(['reduced', ' ReDuCeD ', '2'])('accepts a fee tax class by trimmed name or id: %s', async taxClass => {
  const command = { ...V5_ORDER, payload: { ...V5_ORDER.payload, fees: [{ ...V5_ORDER.payload.fees![0], taxClass }] } };
  expect((await send(await signedIn(), command))[0].status).toBe('applied');
});

it('applies register commands in array order, enforces one open session and closure numbering, and replays recorded results', async () => {
  const session = await signedIn();
  const open = register('register.session.open', 'open', { sessionId: 'session', registerId: 'register', openedAt: TIME, countedFloatMinor: 1000 });
  const another = register('register.session.open', 'another', { ...open.payload, sessionId: 'another-session' });
  const closure = register('register.closure.submit', 'closure', {
    closureId: 'closure', sessionId: 'session', registerId: 'register', number: 1, openedAt: TIME, closedAt: TIME,
    tillExpected: { cash: 2904 }, counted: { cash: 2900 }, periodSalesTotalMinor: 1904, periodRefundsTotalMinor: 0,
    perpetualSalesTotalMinor: 1904, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
    softwareVersion: 'demo-test', orderIds: ['order'], movementIds: ['movement', 'void'],
  });
  const results = await send(session, open, another, ORDER,
    register('register.session.transition', 'counting', { sessionId: 'session', status: 'counting', at: TIME }),
    register('register.movement.record', 'movement', { movementId: 'movement', sessionId: 'session', type: 'paid_in', amountMinor: 100, reason: 'Float', createdAt: TIME }),
    register('register.movement.void', 'void', { movementId: 'void', sessionId: 'session', voids: 'movement', createdAt: TIME }),
    { ...closure, id: 'wrong-number', payload: { ...closure.payload, number: 2 } }, closure);
  expect(results[0].register?.session).toEqual({ id: 'session', status: 'open', expected: { cash: 1000 }, salesCount: 0 });
  expect(results[1].error).toMatchObject({ code: 'register_session_already_open', data: { sessionId: 'session' } });
  expect(results[3].register?.session).toEqual({ id: 'session', status: 'counting', expected: { cash: 2904 }, salesCount: 1 });
  expect(results[4].register?.session?.expected).toEqual({ cash: 3004 });
  expect(results[5].register?.session?.expected).toEqual({ cash: 2904 });
  expect(results[6].error?.code).toBe('register_closure_number_invalid');
  expect(results[7]).toMatchObject({ status: 'applied', register: {
    closure: { serverClosureId: 'closure', number: 1, expected: { cash: 2904 }, variance: { cash: -4 } },
    counters: { lastClosureNumber: 1, perpetualSalesTotalMinor: 1904, perpetualRefundsTotalMinor: 0 },
  } });
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect(await send(session, open, closure)).toEqual([{ ...results[0], status: 'duplicate' }, { ...results[7], status: 'duplicate' }]);
  expect(await send(session, another)).toEqual([results[1]]);
  expect((await send(session, { ...another, id: 'new-open' }))[0].status).toBe('applied');
});

it('supports all order versions and refuses unsupported versions without claiming their ids', async () => {
  const session = await signedIn();
  const unsupported = { ...ORDER, version: 6 } as unknown as AnyCommandEnvelope;
  expect((await send(session, unsupported))[0].error).toMatchObject({ code: 'unsupported_version', data: { orderCreate: 5 } });
  expect((await send(session, ORDER))[0].status).toBe('applied');
  for (const version of [1, 2, 3] as const) {
    const payload = { ...ORDER.payload, clientOrderId: `order-${version}` };
    if (version < 3) { delete payload.display; delete payload.taxByRate; delete payload.sessionId; }
    expect((await send(session, { ...ORDER, id: `v${version}`, version, payload }))[0].status).toBe('applied');
  }
  const open = register('register.session.open', 'open', { sessionId: 'session', registerId: 'register', openedAt: TIME, countedFloatMinor: 0 });
  expect((await send(session, { ...open, version: 2 }))[0].error).toMatchObject({ code: 'unsupported_version', data: { register: 1 } });
  expect((await send(session, open))[0].status).toBe('applied');
});

it('passes other origins through unchanged and restores the exact original fetch', async () => {
  const request = new Request('https://another.invalid/resource', { method: 'POST', body: 'unchanged' });
  const init = { headers: { 'X-Test': 'untouched' } };
  expect(await (await fetch(request, init)).text()).toBe('outside');
  expect(original.mock.calls[0][0]).toBe(request);
  expect(original.mock.calls[0][1]).toBe(init);
  expect(await request.text()).toBe('unchanged');
  installed.uninstall();
  expect(globalThis.fetch).toBe(original);
});

it('resets stock and the ledger back to the seed and removes the storage key', async () => {
  const session = await signedIn();
  await send(session, ORDER);
  installed.reset();
  expect(values.has(DEMO_STORAGE_KEY)).toBe(false);
  expect(await mugStock(session)).toBe(CATALOGUE[0].variants[0].shopFloorStock);
  expect((await send(session, ORDER))[0].status).toBe('applied');
});

it('names an unknown GraphQL operation in a status-200 error', async () => {
  const response = await fetch(`${DEMO_STORE_ORIGIN}/admin-api`, {
    method: 'POST', body: JSON.stringify({ query: 'query MissingDemoOperation { unknown }' }),
  });
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ errors: [{ message: 'Unknown operation: MissingDemoOperation' }] });
});

it('a saved demo state from before customers still searches the seeded customers', () => {
  storage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ stock: {}, ledger: {}, orders: [], sessions: {}, movements: [], closures: [] }));
  const store = new DemoStore(storage);
  expect(store.customers({ q: 'ada' }).items[0].emailAddress).toBe('ada@demo.vendurepos.com');
});

it('searches demo customers by email or name, case-insensitively', async () => {
  const session = await signedIn();
  const context = sessionContext(session);
  const connector = createVendureConnector();
  const ada = { id: 'c1', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@demo.vendurepos.com' };
  for (const query of ['ADA@DEMO.VENDUREPOS.COM', 'aDa', 'LOVElaCE']) {
    expect(await connector.searchCustomers!(context, query)).toEqual([ada]);
  }
  expect((await connector.searchCustomers!(context, 'demo.vendurepos.com')).map(customer => customer.name))
    .toEqual(['Grace Hopper', 'Ada Lovelace', 'Alan Turing']);
  expect((await connector.searchCustomers!(context, 'demo.vendurepos.com', { limit: 1 })).map(customer => customer.id)).toEqual(['c2']);
  expect(await connector.searchCustomers!(context, 'nobody')).toEqual([]);
  expect(await connector.getCustomer!(context, 'c1')).toEqual(ada);
  expect(await connector.getCustomer!(context, 'unknown')).toBeNull();
  const response = await fetch(`${DEMO_STORE_ORIGIN}/admin-api`, {
    method: 'POST', body: JSON.stringify({ query: 'query { customers { totalItems items { id } } }', variables: { take: 1 } }),
  });
  expect(await response.json()).toEqual({ data: { customers: { totalItems: 3, items: [{ id: 'c2' }] } } });
  const payload = { ...ORDER.payload, customer: { customerId: ada.id } };
  expect((await send(session, { ...ORDER, payload }))[0].status).toBe('applied');
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders[0].customer).toEqual(payload.customer);
});

it('creates a demo customer and refuses its email twice, as Vendure does', async () => {
  const session = await signedIn();
  const context = sessionContext(session);
  const connector = createVendureConnector();
  const input = { email: 'empty-names@demo.vendurepos.com', firstName: '', lastName: '', phone: '+44 20 7946 0001' };
  const customer = await connector.createCustomer!(context, input);
  expect(customer).toEqual({ id: 'c4', name: input.email, email: input.email, phone: input.phone });
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect(await connector.getCustomer!(context, customer.id)).toEqual(customer);
  expect(await connector.searchCustomers!(context, input.email)).toEqual([customer]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${DEMO_STORE_ORIGIN}/admin-api`, {
      method: 'POST', body: JSON.stringify({
        query: 'mutation($input: CreateCustomerInput!) { createCustomer(input: $input) { __typename ... on Customer { id } ... on ErrorResult { errorCode message } } }',
        variables: { input: { emailAddress: input.email, firstName: '', lastName: '' } },
      }),
    });
    expect(await response.json()).toEqual({ data: { createCustomer: {
      __typename: 'EmailAddressConflictError', errorCode: 'EMAIL_ADDRESS_CONFLICT_ERROR', message: 'The email address is not available.',
    } } });
  }
  expect(await connector.searchCustomers!(context, input.email)).toEqual([customer]);
  const payload = { ...ORDER.payload, customer: { customerId: customer.id } };
  expect((await send(session, { ...ORDER, payload }))[0].status).toBe('applied');
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders[0].customer).toEqual(payload.customer);
});

it('Reset demo removes created customers', async () => {
  const context = sessionContext(await signedIn());
  const connector = createVendureConnector();
  const customer = await connector.createCustomer!(context, { email: 'new@demo.vendurepos.com', firstName: 'New', lastName: 'Visitor' });
  installed.reset();
  expect(values.has(DEMO_STORAGE_KEY)).toBe(false);
  expect(await connector.searchCustomers!(context, customer.email!)).toEqual([]);
  expect(await connector.getCustomer!(context, customer.id)).toBeNull();
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect((await connector.searchCustomers!(context, 'demo.vendurepos.com')).map(customer => customer.id)).toEqual(['c2', 'c1', 'c3']);
});
