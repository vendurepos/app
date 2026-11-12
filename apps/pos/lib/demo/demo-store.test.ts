import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVendureConnector, createVendureVariantFeedReplication, getVendureOrder, listVendureOrders, type VendureOrder } from '@tallyui/connector-vendure';
import { isCommandBatchResponse, type AnyCommandEnvelope, type CommandEnvelope, type OrderCreatePayload, type RegisterCommandEnvelope } from '@tallyui/core';
import { parseCommandResult } from '@tallyui/core/server';
import { signIn } from '../sign-in';
import { sessionContext, type Session } from '../session';
import { orderTransport } from '../order-transport';
import { loadOrderHistory } from '../order-history';
import { orderDetailView } from '../order-detail';
import { storedReceiptData } from '../stored-receipt';
import { readCapabilities } from '../use-sale-settings';
import { buildRefundEnvelope, type RefundTill } from '../till-refund';
import { logout } from '../logout';
import { barcodeOf, CATALOGUE } from './catalogue';
import { CATALOGUE as DEV_CATALOGUE } from '../../../../dev/vendure-store/src/catalogue';
import { DEMO_CHANNEL_TOKEN, DEMO_CREDENTIALS, DEMO_STORE_ORIGIN, installDemoStore } from './fetch';
import { demoCategoryImage, demoProductImage } from './product-images';
import { DEMO_INFO, DEMO_STORAGE_KEY, DemoStore, largestRemainder, type DemoStorage } from './store';

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
  expect(DEMO_INFO).toMatchObject({ contracts: { 'order.create': [1, 2, 3, 4, 5], 'order.refund': [1] }, maxShippingLines: 1, lineTax: { none: true, classes: true } });
  expect(await readCapabilities(await signedIn(), createVendureConnector())).toEqual({
    orderCreate: 5, orderRefund: 1, register: 1, taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
    lineTax: { none: true, classes: true },
  });
});

it('keeps the demo catalogue equal to the dev catalogue with five stocked categories', () => {
  expect(CATALOGUE).toEqual(DEV_CATALOGUE);
  expect(CATALOGUE).toHaveLength(30);
  expect(new Set(CATALOGUE.map(product => product.slug)).size).toBe(30);
  const variants = CATALOGUE.flatMap(product => product.variants);
  expect(new Set(variants.map(variant => variant.sku)).size).toBe(variants.length);
  for (const category of ['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts']) {
    expect(CATALOGUE.filter(product => product.category === category).length).toBeGreaterThanOrEqual(4);
  }
  const added = CATALOGUE.slice(10);
  expect(added.filter(product => product.variants.length > 1)).toHaveLength(4);
  expect(added.filter(product => !product.trackInventory)).toHaveLength(1);
  expect(added.filter(product => product.trackInventory && product.variants.every(variant => variant.shopFloorStock === 0))).toHaveLength(2);
});

// The SVG document inside a demo picture's data URI.
function svgOf(uri: string) {
  // react-native-web re-encodes a ";utf8," SVG payload, which breaks an already-encoded one.
  expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  return decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
}

it('gives every product its own bundled SVG picture under 1.5 KB, and variants none of their own', () => {
  const products = new DemoStore(storage).products();
  const connector = createVendureConnector();
  for (const product of products) {
    const svg = svgOf(product.featuredAsset.preview);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 160 160">.*<\/svg>$/);
    expect(new TextEncoder().encode(svg).length).toBeLessThan(1536);
    expect(svg).not.toMatch(/<text|Gradient|filter|https?:\/\/(?!www\.w3\.org\/2000\/svg")/);
    expect(product.assets).toEqual([product.featuredAsset]);
    expect(connector.traits.product!.getImageUrl(product)).toBe(product.featuredAsset.preview);
    expect(product.variants.every(variant => variant.featuredAsset === null)).toBe(true);
    const category = CATALOGUE.find(entry => entry.slug === product.slug)!.category;
    expect(product.featuredAsset.preview).not.toBe(demoCategoryImage(category));
  }
  expect(new Set(products.map(product => product.featuredAsset.preview)).size).toBe(products.length);
  expect(new Set(products.map(product => product.featuredAsset.id)).size).toBe(products.length);
});

it('falls back to a category picture for an unknown slug instead of throwing', () => {
  expect(demoProductImage('no-such-slug')).toBe(demoCategoryImage('Gifts'));
  expect(demoProductImage('no-such-slug', 'Coffee')).toBe(demoCategoryImage('Coffee'));
  for (const category of ['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts'] as const) {
    expect(new TextEncoder().encode(svgOf(demoCategoryImage(category))).length).toBeLessThan(1536);
  }
});

it('seeds three historic server orders without changing the till stock baseline', () => {
  const store = new DemoStore(storage);
  expect(store.customers().totalItems).toBe(8);
  // Persist the initial history without applying an order or touching stock.
  store.createCustomer({ firstName: 'Test', lastName: 'Visitor', emailAddress: 'test@example.com' });
  const state = JSON.parse(values.get(DEMO_STORAGE_KEY)!);
  expect(state.orders).toHaveLength(3);
  expect(state.orders.map((order: OrderCreatePayload) => [order.subtotalMinor, order.taxMinor, order.totalMinor]))
    .toEqual([[800, 152, 952], [2198, 154, 2352], [1499, 285, 1784]]);
  expect(state.orders.map((order: OrderCreatePayload) => order.lines.map(line => line.variantId)))
    .toEqual([['1'], ['2', '4'], ['15']]);
  expect(state.orders[2].customer).toEqual({ email: 'ada@demo.vendurepos.com' });
  for (const product of store.products()) for (const variant of product.variants) {
    const seeded = CATALOGUE.flatMap(product => product.variants).find(seeded => seeded.sku === variant.sku)!;
    expect(variant.stockLevels[0].stockOnHand).toBe(seeded.shopFloorStock);
  }
});

it('lists the seeded orders newest first through the real connector, then a sale, and the seeds again after Reset demo', async () => {
  const session = await signedIn();
  const seeded = await loadOrderHistory(session);
  expect(seeded).toHaveProperty('orders');
  if (!('orders' in seeded)) throw new Error(seeded.notice.text);
  expect(seeded.orders.map(order => order.id)).toEqual(['3', '2', '1']);
  expect(seeded.orders[0]).toMatchObject({
    code: 'DEMO-000003', state: 'PaymentSettled', orderPlacedAt: '2025-12-30T14:00:00.000Z',
    currencyCode: 'EUR', totalQuantity: 1,
    customer: { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', emailAddress: 'ada@demo.vendurepos.com' },
    customFields: { tallyClientOrderId: 'seed-order-3' },
  });
  const limited = await listVendureOrders(sessionContext(session), { take: 2 });
  expect(limited.items).toHaveLength(2);
  expect(limited.totalItems).toBe(3);
  expect((await send(session, ORDER))[0].status).toBe('applied');
  expect(seeded.orders[0].totalWithTax).toBe(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders[2].totalMinor);
  const sold = await loadOrderHistory(session);
  expect(sold).toHaveProperty('orders');
  if (!('orders' in sold)) throw new Error(sold.notice.text);
  expect(sold.orders[0]).toMatchObject({
    id: '4', code: 'DEMO-000004', totalWithTax: 1904, total: 1600, totalQuantity: 2,
    customFields: { tallyClientOrderId: 'order' },
  });
  installed.reset();
  expect(await loadOrderHistory(session)).toEqual(seeded);
  expect(original).not.toHaveBeenCalled();
});

it('splits integer totals by largest remainder, with earlier lines winning ties', () => {
  expect(largestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
  expect(largestRemainder(10, [0, 0])).toEqual([5, 5]);
  expect(largestRemainder(1904, [1600])).toEqual([1904]);
  const weights = [3, 7, 11];
  const shares = largestRemainder(1001, weights);
  expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1001);
  shares.forEach((share, index) => {
    expect(Number.isInteger(share)).toBe(true);
    expect(Math.abs(share - 1001 * weights[index] / 21)).toBeLessThan(1);
  });
});

it('reads a seeded order detail through sign-in and the real connector', async () => {
  const session = await signedIn();
  const order = await getVendureOrder(sessionContext(session), '1');
  expect(order).toMatchObject({ code: 'DEMO-000001', state: 'PaymentSettled', totalWithTax: 952,
    customFields: { tallyClientOrderId: 'seed-order-1' } });
  expect(order!.lines).toHaveLength(1);
  expect(order!.lines[0]).toMatchObject({ productVariant: { sku: 'TALLY-MUG' }, quantity: 1,
    proratedLinePriceWithTax: 952, taxRate: 19 });
  expect(order!.payments![0]).toMatchObject({ amount: 952, state: 'Settled', method: 'tally-pos', metadata: { tender: { method: 'cash' } } });
  const view = orderDetailView(order!);
  expect(view.total).toBe('€9.52');
  expect(view.lineItems[0].total).toBe('€9.52');
});

it('a demo sale paid with change reprints with the charged total, the tendered cash and the change', async () => {
  const session = await signedIn();
  const [cash] = ORDER.payload.payments;
  expect(cash).toMatchObject({ method: 'cash', amountMinor: ORDER.payload.totalMinor, tenderedMinor: 2000 });
  expect(cash.changeMinor).toBe(cash.tenderedMinor! - ORDER.payload.totalMinor);
  const [applied] = await send(session, ORDER);
  expect(applied).toMatchObject({ status: 'applied', serverRefs: { orderId: '4' } });
  const detail = new DemoStore(storage).order('4') as unknown as VendureOrder;
  const receipt = storedReceiptData(detail, { storeName: 'x', pricesIncludeTax: ORDER.payload.pricesIncludeTax });
  expect(receipt.totals.totalMinor).toBe(detail.totalWithTax);
  expect(receipt.payments).toEqual([{ method: 'cash', amountMinor: 2000 }]);
  expect(receipt.changeDueMinor).toBe(2000 - detail.totalWithTax);
  expect(receipt.payments[0].amountMinor - receipt.changeDueMinor).toBe(receipt.totals.totalMinor);
});

it('reads v5 detail with charges separate from the exact goods allocation and matching summary fields', async () => {
  const session = await signedIn();
  expect((await send(session, V5_ORDER))[0].status).toBe('applied');
  const context = sessionContext(session);
  const order = (await getVendureOrder(context, '4'))!;
  expect(order.lines).toHaveLength(2);
  expect(order.lines[1].customFields?.tallyCustomName).toBe('Gift wrapping');
  expect(order.surcharges[0].priceWithTax).toBe(119);
  expect(order.shippingLines[0].priceWithTax).toBe(238);
  expect(order.lines.reduce((sum, line) => sum + line.proratedLinePriceWithTax, 0)).toBe(order.subTotalWithTax);
  expect(order.subTotalWithTax).toBe(3332 - 119 - 238);
  expect(order.subTotalWithTax + order.surcharges.reduce((sum, charge) => sum + charge.priceWithTax, 0) + order.shippingWithTax)
    .toBe(order.totalWithTax);
  expect(order.totalWithTax).toBe(3332);
  expect(order.total).toBe(3332 - 532);
  expect(order.taxSummary).toEqual([{ description: 'Standard DE', taxRate: 19, taxBase: 2800, taxTotal: 532 }]);
  expect(order.customFields?.tallySnapshot).toBe(JSON.stringify({ display: V5_ORDER.payload.display, taxByRate: V5_ORDER.payload.taxByRate }));
  const summary = (await listVendureOrders(context)).items.find(row => row.id === '4');
  expect(summary).toBeDefined();
  expect(order).toMatchObject(summary!);
});

it('returns null through the real connector for an order that does not exist', async () => {
  const session = await signedIn();
  expect(await getVendureOrder(sessionContext(session), '99')).toBeNull();
});

it('pulls the whole catalogue with paginated replication and honours its checkpoints', async () => {
  const context = sessionContext(await signedIn());
  const connector = createVendureConnector({ barcodeField: 'barcode' });
  const pull = connector.replication!.products!.pull;
  const products: any[] = [];
  let checkpoint;
  for (let pass = 0; pass < 10; pass++) {
    const result = await pull.handler(checkpoint, 3, context);
    products.push(...result.documents);
    checkpoint = result.checkpoint;
  }
  expect(products).toHaveLength(30);
  expect(new Set(products.flatMap(product => product.collections.map((collection: { name: string }) => collection.name))))
    .toEqual(new Set(['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts']));
  expect(products.flatMap(product => product.variants)).toHaveLength(46);
  expect(new Set(products.map(product => product.id)).size).toBe(30);
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
  expect(await sync.fetchAllIds(context)).toHaveLength(30);
  expect((await sync.fetchByIds(['1', '10'], context)).map(product => product.id)).toEqual(['1', '10']);
  expect(await sync.fetchModifiedAfter!('2000-01-01T00:00:00.000Z', context)).toHaveLength(30);
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
  // Three historic orders are seeded before this sale.
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toHaveLength(4);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders.slice(3)).toEqual([ORDER.payload]);
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
  // Three historic orders are seeded before this sale.
  expect(state.orders).toHaveLength(4);
  expect(state.orders.slice(3)).toEqual([V5_ORDER.payload]);
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
  // Only the three seeded historic orders remain after rejection.
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toHaveLength(3);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders.slice(3)).toEqual([]);
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
  // Only the three seeded historic orders remain after rejection.
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders).toHaveLength(3);
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders.slice(3)).toEqual([]);
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
    .toEqual(['Grace Hopper', 'Katherine Johnson', 'Donald Knuth', 'Barbara Liskov', 'Ada Lovelace', 'Margaret Mead', 'Alan Turing', 'Dorothy Vaughan']);
  expect((await connector.searchCustomers!(context, 'demo.vendurepos.com', { limit: 1 })).map(customer => customer.id)).toEqual(['c2']);
  expect(await connector.searchCustomers!(context, 'nobody')).toEqual([]);
  expect(await connector.getCustomer!(context, 'c1')).toEqual(ada);
  expect(await connector.getCustomer!(context, 'unknown')).toBeNull();
  const response = await fetch(`${DEMO_STORE_ORIGIN}/admin-api`, {
    method: 'POST', body: JSON.stringify({ query: 'query { customers { totalItems items { id } } }', variables: { take: 1 } }),
  });
  expect(await response.json()).toEqual({ data: { customers: { totalItems: 8, items: [{ id: 'c2' }] } } });
  const payload = { ...ORDER.payload, customer: { customerId: ada.id } };
  expect((await send(session, { ...ORDER, payload }))[0].status).toBe('applied');
  // Three historic orders are seeded before this customer sale.
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders[3].customer).toEqual(payload.customer);
});

it('creates a demo customer and refuses its email twice, as Vendure does', async () => {
  const session = await signedIn();
  const context = sessionContext(session);
  const connector = createVendureConnector();
  const input = { email: 'empty-names@demo.vendurepos.com', firstName: '', lastName: '', phone: '+44 20 7946 0001' };
  const customer = await connector.createCustomer!(context, input);
  expect(customer).toEqual({ id: 'c9', name: input.email, email: input.email, phone: input.phone });
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
  // Three historic orders are seeded before this customer sale.
  expect(JSON.parse(values.get(DEMO_STORAGE_KEY)!).orders[3].customer).toEqual(payload.customer);
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
  expect((await connector.searchCustomers!(context, 'demo.vendurepos.com')).map(customer => customer.id))
    .toEqual(['c2', 'c4', 'c6', 'c5', 'c1', 'c7', 'c3', 'c8']);
});

// The till the refund tests open: register 'register', session 'session', float EUR 10.00.
const OPEN = register('register.session.open', 'open', { sessionId: 'session', registerId: 'register', openedAt: TIME, countedFloatMinor: 1000 });
const TILL: RefundTill = { sessionId: 'session', registerId: 'register', deviceId: 'till', cashierRef: 'cashier@demo.vendurepos.com' };
// Three mugs paid unevenly by cash and card (a till card payment is method 'external'), with ORDER's tax shape.
const SPLIT: CommandEnvelope<OrderCreatePayload> = { ...ORDER, id: 'split-command', payload: { ...ORDER.payload, clientOrderId: 'split',
  lines: [{ ...ORDER.payload.lines[0], quantity: 3 }], subtotalMinor: 2400, taxMinor: 456, totalMinor: 2856,
  payments: [{ clientPaymentId: 'cash', method: 'cash', amountMinor: 2000 }, { clientPaymentId: 'card', method: 'external', amountMinor: 856 }],
  display: { ...ORDER.payload.display!, subtotalMinor: 2400, taxMinor: 456, totalMinor: 2856, lines: [{ clientLineId: 'line', amountMinor: 2400, discounts: [] }] },
  taxByRate: [{ ratePpm: 190000, code: 'Standard DE', netMinor: 2400, taxMinor: 456, grossMinor: 2856 }] } };

async function detail(session: Session, id: string) {
  const order = await getVendureOrder(sessionContext(session), id);
  if (!order) throw new Error(`No order ${id}`);
  return order;
}

/** The app's own envelope refunding `quantity` of the order's first line, with restock, under ids named after `name`. */
function refundEnvelope(order: Awaited<ReturnType<typeof detail>>, quantity: number, name: string, till = TILL) {
  return buildRefundEnvelope(order, { quantities: { [order.lines[0].id]: quantity }, reason: 'Damaged', restock: true }, till,
    { id: `${name}-command`, clientRefundId: name, now: TIME });
}

/** The live session's expected cash, read from a register command's result. */
async function expectedCash(session: Session, id: string) {
  const [result] = await send(session, register('register.session.transition', id, { sessionId: 'session', status: 'open', at: TIME }));
  return result.register!.session!.expected!.cash;
}

it('refunds a till sale a mug at a time: on the order, back in stock, out of expected cash, then nothing left', async () => {
  const session = await signedIn();
  expect((await send(session, OPEN, ORDER)).map(result => result.status)).toEqual(['applied', 'applied']);
  const sold = await mugStock(session);
  const before = await detail(session, '4');
  expect(await expectedCash(session, 'cash-sold')).toBe(2904);
  const [first] = await send(session, refundEnvelope(before, 1, 'first'));
  expect(first).toMatchObject({ status: 'applied', refund: { totalMinor: 952, byMethod: { cash: 952 } } });
  expect(first.refund!.refunds).toEqual([{ id: '1', paymentId: '4-p1', totalMinor: 952, state: 'Settled' }]);
  expect(await mugStock(session)).toBe(sold + 1);
  expect((await detail(session, '4')).payments![0].refunds)
    .toEqual([expect.objectContaining({ total: 952, state: 'Settled', lines: [{ orderLineId: '4-1', quantity: 1 }] })]);
  expect(await expectedCash(session, 'cash-first')).toBe(1952);
  const [second] = await send(session, refundEnvelope(await detail(session, '4'), 1, 'second'));
  expect(second).toMatchObject({ status: 'applied', refund: { totalMinor: 952 } });
  const [third] = await send(session, refundEnvelope(before, 1, 'third'));
  expect(third).toMatchObject({ status: 'rejected', error: { code: 'quantity_exceeds' } });
  expect((third.error!.data as { lines: { refundableQuantity: number }[] }).lines[0].refundableQuantity).toBe(0);
});

it('replays an applied refund as a duplicate and refuses its refund id under a new command id', async () => {
  const session = await signedIn();
  await send(session, OPEN, ORDER);
  const envelope = refundEnvelope(await detail(session, '4'), 1, 'once');
  const [applied] = await send(session, envelope);
  expect(applied.status).toBe('applied');
  expect(await send(session, envelope)).toEqual([{ ...applied, status: 'duplicate' }]);
  expect((await send(session, { ...envelope, id: 'another-command' }))[0])
    .toMatchObject({ status: 'rejected', error: { code: 'invalid_payload', message: 'clientRefundId: once is already refund 1' } });
});

it('refuses a total a cent off without recording it, so the right total under the same id applies', async () => {
  const session = await signedIn();
  await send(session, OPEN, ORDER);
  const envelope = refundEnvelope(await detail(session, '4'), 1, 'cent');
  expect((await send(session, { ...envelope, payload: { ...envelope.payload, totalMinor: 951 } }))[0]).toMatchObject({ status: 'rejected',
    error: { code: 'amount_mismatch', message: "Refund total 951 does not match the server's 952", data: { expectedMinor: 951, serverMinor: 952 } } });
  expect((await send(session, envelope))[0].status).toBe('applied');
});

it('refuses an unsupported version and a session that is not open, recording neither', async () => {
  const session = await signedIn();
  await send(session, OPEN, ORDER);
  const envelope = refundEnvelope(await detail(session, '4'), 1, 'nope', { ...TILL, sessionId: 'nope' });
  expect((await send(session, { ...envelope, version: 2 } as unknown as AnyCommandEnvelope))[0].error)
    .toMatchObject({ code: 'unsupported_version', data: { orderRefund: 1 } });
  expect((await send(session, envelope))[0].error).toEqual({ code: 'no_open_session',
    message: 'Session nope is not open on register register', data: { sessionId: 'nope' } });
});

it('splits a refund over cash then card, with the lines on the first refund only', async () => {
  const session = await signedIn();
  await send(session, OPEN, SPLIT);
  const [applied] = await send(session, refundEnvelope(await detail(session, '4'), 3, 'uneven'));
  expect(applied).toMatchObject({ status: 'applied', refund: { totalMinor: 2856, byMethod: { cash: 2000, external: 856 } } });
  expect(applied.refund!.refunds.map(refund => [refund.paymentId, refund.totalMinor])).toEqual([['4-p1', 2000], ['4-p2', 856]]);
  const { payments } = await detail(session, '4');
  expect(payments![0].refunds[0].lines).toEqual([{ orderLineId: '4-1', quantity: 3 }]);
  expect(payments![1].refunds[0].lines).toEqual([]);
});

it('a saved demo state from before refunds loads, reads the seeded orders and takes a refund', async () => {
  const session = await signedIn();
  await send(session, OPEN, ORDER);
  const saved = JSON.parse(values.get(DEMO_STORAGE_KEY)!);
  delete saved.refunds;
  values.set(DEMO_STORAGE_KEY, JSON.stringify(saved));
  installed.uninstall();
  installed = installDemoStore(DEMO_STORE_ORIGIN, { storage });
  expect((await detail(session, '1')).customFields?.tallyClientOrderId).toBe('seed-order-1');
  expect((await send(session, refundEnvelope(await detail(session, '4'), 1, 'old')))[0].status).toBe('applied');
});

it('counts a refund of a seeded order in the session that made it', async () => {
  const session = await signedIn();
  await send(session, OPEN);
  const [applied] = await send(session, refundEnvelope(await detail(session, '1'), 1, 'seeded'));
  expect(applied).toMatchObject({ status: 'applied', refund: { totalMinor: 952, byMethod: { cash: 952 } } });
  expect(await expectedCash(session, 'cash-seeded')).toBe(1000 - 952);
});

// 3 mugs less EUR 1.00 is 2300 net, 2737 with tax: 2737 does not divide by 3.
const UNEVEN: CommandEnvelope<OrderCreatePayload> = { ...ORDER, id: 'uneven-order-command', payload: { ...ORDER.payload, clientOrderId: 'uneven-order',
  lines: [{ ...ORDER.payload.lines[0], quantity: 3, discountMinor: 100 }], subtotalMinor: 2300, discountMinor: 100, taxMinor: 437, totalMinor: 2737,
  payments: [{ clientPaymentId: 'cash', method: 'cash', amountMinor: 2737 }],
  display: { ...ORDER.payload.display!, subtotalMinor: 2300, discountMinor: 100, taxMinor: 437, totalMinor: 2737,
    lines: [{ clientLineId: 'line', amountMinor: 2300, discounts: [{ discountId: 'discount', amountMinor: 100 }] }] },
  taxByRate: [{ ratePpm: 190000, code: 'Standard DE', netMinor: 2300, taxMinor: 437, grossMinor: 2737 }] } };

it('refunds an uneven line a unit at a time in shares that add up to the line total', async () => {
  const session = await signedIn();
  expect((await send(session, OPEN, UNEVEN)).map(result => result.status)).toEqual(['applied', 'applied']);
  expect((await detail(session, '4')).lines[0].proratedLinePriceWithTax).toBe(2737);
  const totals: number[] = [];
  for (const name of ['u1', 'u2', 'u3']) {
    const [result] = await send(session, refundEnvelope(await detail(session, '4'), 1, name));
    expect(result.status).toBe('applied');
    totals.push(result.refund!.totalMinor);
  }
  expect(totals).toEqual([912, 913, 912]);
  expect(totals.reduce((sum, total) => sum + total, 0)).toBe(2737);
});
