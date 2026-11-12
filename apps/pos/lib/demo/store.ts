import type {
  CommandResult, OrderCreatePayload, OrderRefundPayload, OrderRefundResult, RegisterClosureSubmitPayload, RegisterCommandResult, RegisterSessionOpenPayload,
} from '@tallyui/core';
import { barcodeOf, CATALOGUE } from './catalogue';
import { demoProductImage } from './product-images';

// All mutable demo data is saved together, including the command ledger.
export const DEMO_STORAGE_KEY = 'vendurepos.demo-store.v1';
// Matches plugin 0.3.0's info.controller.ts with the dev store's OrderLevelTaxCalculationStrategy.
export const DEMO_INFO = {
  contracts: { 'order.create': [1, 2, 3, 4, 5], register: [1], 'order.refund': [1] },
  maxShippingLines: 1,
  lineTax: { none: true, classes: true },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
};
// The demo exposes the seed's tax-exclusive EUR shop-floor channel.
export const DEMO_CHANNEL = { defaultCurrencyCode: 'EUR', pricesIncludeTax: false, defaultTaxZone: { id: 'DE' } };
// Category ids shared by settings, rates and variant reads.
export const DEMO_CATEGORIES = [{ id: '1', name: 'Standard', isDefault: true }, { id: '2', name: 'Reduced', isDefault: false }];
// Stable product collection ids, separate from tax categories.
const DEMO_COLLECTIONS = ['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts']
  .map((name, index) => ({ id: `cat${index + 1}`, name }));
// The four rates in dev/vendure-store/src/seed.ts, before filtering to the channel's zone.
export const DEMO_RATES = [
  { name: 'Standard DE', value: 19, category: { id: '1' }, zoneId: 'DE' },
  { name: 'Reduced DE', value: 7, category: { id: '2' }, zoneId: 'DE' },
  { name: 'Standard DK', value: 25, category: { id: '1' }, zoneId: 'DK' },
  { name: 'Reduced DK', value: 25, category: { id: '2' }, zoneId: 'DK' },
].map(rate => ({ ...rate, enabled: true, customerGroup: null }));
// Stable initial timestamps allow the connector's updatedAt probes and checkpoints to work.
const SEED_TIME = '2026-01-01T00:00:00.000Z';
// Only the seed's shop-floor location is visible in the simulated POS channel.
const STOCK_LOCATION_ID = '2';
// Vendure expresses tax rates as percentages.
const PERCENT = 100;
// Payload tax rates use parts per million; Vendure uses percentages.
const PPM_PER_PERCENT = 10_000;
// The real plugin records POS payments under this method code.
const DEMO_PAYMENT_METHOD = 'tally-pos';

export type DemoStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Command = { id: string; type: string; version: number; payload: any };
type Session = RegisterSessionOpenPayload & { status: 'open' | 'counting' | 'closed' };
type Movement = { movementId: string; sessionId: string; type: string; amountMinor: number; voids?: string };
type Customer = { __typename: 'Customer'; id: string; firstName: string; lastName: string; emailAddress: string; phoneNumber: string | null };
// One Vendure Refund on one payment; paymentIndex is the order's payment, method its till method.
type DemoRefund = {
  id: string; orderId: string; paymentIndex: number; total: number; shipping: number;
  lines: { orderLineId: string; quantity: number }[]; reason: string;
  clientRefundId: string; sessionId: string; method: string;
};
// The fields of order()'s detail the refund rules read.
type RefundableOrder = {
  id: string; shippingWithTax: number; customFields: { tallyClientOrderId: string };
  lines: { id: string; quantity: number; proratedLinePriceWithTax: number; productVariant: { id: string } }[];
  payments: { id: string; amount: number; metadata: { tender: { method: string } } }[];
};
type State = {
  customers: Customer[];
  stock: Record<string, { quantity: number; updatedAt: string }>;
  ledger: Record<string, { fingerprint: string; result: CommandResult }>;
  orders: OrderCreatePayload[]; sessions: Record<string, Session>;
  movements: Movement[]; closures: RegisterClosureSubmitPayload[];
  refunds: DemoRefund[];
};

function seed(): State {
  const stock: State['stock'] = {};
  let index = 0;
  for (const product of CATALOGUE) for (const variant of product.variants) {
    index++;
    if (product.trackInventory) stock[String(index)] = { quantity: variant.shopFloorStock, updatedAt: SEED_TIME };
  }
  const customers: Customer[] = [
    ['Ada', 'Lovelace', 'ada@demo.vendurepos.com'],
    ['Grace', 'Hopper', 'grace@demo.vendurepos.com'],
    ['Alan', 'Turing', 'alan@demo.vendurepos.com'],
    ['Katherine', 'Johnson', 'katherine@demo.vendurepos.com'],
    ['Barbara', 'Liskov', 'barbara@demo.vendurepos.com'],
    ['Donald', 'Knuth', 'donald@demo.vendurepos.com'],
    ['Margaret', 'Mead', 'margaret@demo.vendurepos.com'],
    ['Dorothy', 'Vaughan', 'dorothy@demo.vendurepos.com'],
  ].map(([firstName, lastName, emailAddress], index) => ({
    __typename: 'Customer', id: `c${index + 1}`, firstName, lastName, emailAddress, phoneNumber: null,
  }));
  const variants = CATALOGUE.flatMap(product => product.variants.map(variant => ({
    ...variant, title: [product.name, ...variant.options].join(' '),
  })));
  // Server-side history predates the stock baseline; it does not decrement today's till stock.
  const orders: OrderCreatePayload[] = [
    { skus: ['TALLY-MUG'], ratePpm: 190_000, createdAt: '2025-12-28T10:00:00.000Z' },
    { skus: ['ESP-250', 'FIL-500'], ratePpm: 70_000, createdAt: '2025-12-29T11:00:00.000Z' },
    { skus: ['TOTE'], ratePpm: 190_000, createdAt: '2025-12-30T14:00:00.000Z', customer: { email: customers[0].emailAddress } },
  ].map(({ skus, ratePpm, createdAt, customer }, orderIndex) => {
    const clientOrderId = `seed-order-${orderIndex + 1}`;
    const lines = skus.map((sku, lineIndex) => {
      const variantIndex = variants.findIndex(variant => variant.sku === sku);
      const variant = variants[variantIndex];
      return { clientLineId: `${clientOrderId}-${lineIndex + 1}`, variantId: String(variantIndex + 1),
        title: variant.title, quantity: 1, unitPriceMinor: variant.priceMinor };
    });
    const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
    const taxMinor = Math.round(subtotalMinor * ratePpm / 1_000_000);
    const totalMinor = subtotalMinor + taxMinor;
    return { clientOrderId, createdAt, currency: 'EUR', pricesIncludeTax: false, lines, customer,
      subtotalMinor, taxMinor, totalMinor,
      payments: [{ clientPaymentId: `${clientOrderId}-payment`, method: 'cash', amountMinor: totalMinor }],
      display: { currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor, discountMinor: 0,
        taxMinor, totalMinor, orderDiscountMinor: 0,
        lines: lines.map(line => ({ clientLineId: line.clientLineId, amountMinor: line.unitPriceMinor * line.quantity, discounts: [] })) },
      taxByRate: [{ ratePpm, netMinor: subtotalMinor, taxMinor, grossMinor: totalMinor }],
    };
  });
  return { stock, ledger: {}, orders, sessions: {}, movements: [], closures: [], customers, refunds: [] };
}

/** A stock entry's next updatedAt: now, and always later than the last. */
function nextUpdatedAt(updatedAt: string): string {
  return new Date(Math.max(Date.now(), Date.parse(updatedAt) + 1)).toISOString();
}

/** Canonical command content, like the plugin's fingerprint, without its Node-only SHA-256 import. */
function fingerprint({ type, version, payload }: Command): string {
  return JSON.stringify({ type, version, payload }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

function demoOrderCode(id: string): string {
  return `DEMO-${id.padStart(6, '0')}`;
}

export function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map(weight => total * (sum === 0 ? 1 : weight) / (sum || weights.length));
  const shares = exact.map(Math.floor);
  const remaining = total - shares.reduce((sum, share) => sum + share, 0);
  const ranked = exact.map((share, index) => ({ index, remainder: share - shares[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of ranked.slice(0, remaining)) shares[index]++;
  return shares;
}

export class DemoStore {
  private state: State;
  constructor(private storage?: DemoStorage) {
    const saved = storage?.getItem(DEMO_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved); // State saved before customers existed gets the seeded ones; before refunds, none.
      this.state = { ...parsed, customers: Array.isArray(parsed.customers) ? parsed.customers : seed().customers,
        refunds: Array.isArray(parsed.refunds) ? parsed.refunds : [] };
    } else this.state = seed();
  }

  reset(): void {
    this.state = seed();
    this.storage?.removeItem(DEMO_STORAGE_KEY);
  }

  customers({ q = '', take = 20 }: { q?: string; take?: number } = {}) {
    const items = this.state.customers.filter(customer =>
      [customer.emailAddress, customer.firstName, customer.lastName].some(value => value.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => a.lastName.localeCompare(b.lastName));
    return { totalItems: items.length, items: items.slice(0, take) };
  }

  customer(id: string) {
    return this.state.customers.find(customer => customer.id === id) ?? null;
  }

  createCustomer(input: { firstName: string; lastName: string; emailAddress: string; phoneNumber?: string }) {
    if (this.state.customers.some(customer => customer.emailAddress === input.emailAddress)) return {
      __typename: 'EmailAddressConflictError', errorCode: 'EMAIL_ADDRESS_CONFLICT_ERROR', message: 'The email address is not available.',
    };
    const customer: Customer = { ...input, __typename: 'Customer', id: `c${this.state.customers.length + 1}`, phoneNumber: input.phoneNumber ?? null };
    this.state.customers.push(customer);
    this.storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(this.state));
    return customer;
  }

  products() {
    let variantIndex = 0;
    // Each product's bundled picture; variants keep featuredAsset null and fall back to it, as in Vendure.
    const assets: { id: string; preview: string }[] = CATALOGUE.map((product, index) =>
      ({ id: `demo-asset-${index + 1}`, preview: demoProductImage(product.slug) }));
    return CATALOGUE.map((product, index) => ({
      id: String(index + 1), createdAt: SEED_TIME, updatedAt: SEED_TIME,
      name: product.name, slug: product.slug, description: `${product.name} (VendurePOS dev seed)`, enabled: true,
      featuredAsset: assets[index], assets: [assets[index]], collections: DEMO_COLLECTIONS.filter(collection => collection.name === product.category), facetValues: [],
      variants: product.variants.map(variant => {
        const id = String(++variantIndex);
        const category = DEMO_CATEGORIES.find(category => category.name === product.taxCategory)!;
        const rate = DEMO_RATES.find(rate => rate.category.id === category.id && rate.zoneId === DEMO_CHANNEL.defaultTaxZone.id)!;
        return {
          id, productId: String(index + 1), updatedAt: this.state.stock[id]?.updatedAt ?? SEED_TIME,
          name: [product.name, ...variant.options].join(' '), sku: variant.sku,
          price: variant.priceMinor, priceWithTax: Math.round(variant.priceMinor * (PERCENT + rate.value) / PERCENT),
          currencyCode: DEMO_CHANNEL.defaultCurrencyCode, enabled: true, featuredAsset: null,
          trackInventory: product.trackInventory ? 'TRUE' : 'FALSE', outOfStockThreshold: 0, useGlobalOutOfStockThreshold: true,
          stockLevels: [{ stockLocationId: STOCK_LOCATION_ID, stockOnHand: this.state.stock[id]?.quantity ?? variant.shopFloorStock, stockAllocated: 0 }],
          options: variant.options.map((name, optionIndex) => ({
            id: `${index + 1}-${optionIndex}-${name}`, name, code: name.toLowerCase().replace(/\s+/g, '-'),
          })),
          taxCategory: { id: category.id }, customFields: { barcode: barcodeOf(variantIndex - 1) },
        };
      }),
    }));
  }

  /** The store's orders in the connector's VendureOrderSummary shape (TallyUI 3.9.0 listVendureOrders). */
  orderSummaries(): Record<string, unknown>[] {
    return this.state.orders.map((order, index) => {
      const id = String(index + 1);
      const customer = this.state.customers.find(customer =>
        customer.id === order.customer?.customerId || customer.emailAddress === order.customer?.email);
      return {
        id, code: demoOrderCode(id), state: 'PaymentSettled', orderPlacedAt: order.createdAt, updatedAt: order.createdAt,
        currencyCode: order.currency, totalQuantity: order.lines.reduce((sum, line) => sum + line.quantity, 0),
        total: order.totalMinor - order.taxMinor, totalWithTax: order.totalMinor,
        customer: customer ? { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, emailAddress: customer.emailAddress } : null,
        customFields: {
          tallyClientOrderId: order.clientOrderId, tallySaleAt: order.createdAt,
          tallyRegisterId: order.registerId ?? null, tallySessionId: order.sessionId ?? null, tallyCashierRef: order.cashierRef ?? null,
          tallyRejected: false, tallyRejectedClientOrderId: null,
        },
      };
    });
  }

  order(id: string): Record<string, unknown> | null {
    const payload = this.state.orders[Number(id) - 1];
    if (!payload) return null;
    const summary = this.orderSummaries()[Number(id) - 1];
    const surcharges = (payload.fees ?? []).map(fee => {
      const gross = payload.pricesIncludeTax ? fee.amountMinor : fee.amountMinor + fee.taxMinor;
      return { description: fee.name, sku: '', price: gross - fee.taxMinor, priceWithTax: gross };
    });
    const shippingLines = (payload.shipping ?? []).map(entry => {
      const gross = payload.pricesIncludeTax ? entry.amountMinor : entry.amountMinor + entry.taxMinor;
      const net = gross - entry.taxMinor;
      return { shippingMethod: { name: entry.name }, price: net, priceWithTax: gross,
        discountedPrice: net, discountedPriceWithTax: gross };
    });
    const charges = [...surcharges, ...shippingLines];
    const goodsGross = payload.totalMinor - charges.reduce((sum, charge) => sum + charge.priceWithTax, 0);
    const goodsNet = payload.totalMinor - payload.taxMinor - charges.reduce((sum, charge) => sum + charge.price, 0);
    const weights = payload.lines.map(line => Math.max(0, line.unitPriceMinor * line.quantity - (line.discountMinor ?? 0)));
    const grossShares = largestRemainder(goodsGross, weights);
    const netShares = largestRemainder(goodsNet, weights);
    const variants = this.products().flatMap(product => product.variants);
    const lines = payload.lines.map((line, index) => {
      const variant = variants.find(variant => variant.id === line.variantId);
      const taxClass = line.custom?.taxClass;
      const category = DEMO_CATEGORIES.find(category => variant ? category.id === variant.taxCategory.id
        : taxClass !== undefined && (category.id === taxClass || category.name.toLowerCase() === taxClass.trim().toLowerCase()))
        ?? DEMO_CATEGORIES.find(category => category.isDefault)!;
      const taxRate = !variant && line.custom?.taxStatus === 'none' ? 0
        : DEMO_RATES.find(rate => rate.category.id === category.id && rate.zoneId === DEMO_CHANNEL.defaultTaxZone.id)!.value;
      const unitPrice = line.unitPriceMinor;
      const linePrice = unitPrice * line.quantity;
      return {
        id: `${id}-${index + 1}`, quantity: line.quantity, orderPlacedQuantity: line.quantity,
        productVariant: { id: line.variantId ?? '', name: line.custom ? line.custom.name : line.title ?? variant!.name,
          sku: variant?.sku ?? line.custom?.sku ?? '' },
        customFields: { tallyCustomName: line.custom?.name ?? null, tallyCustomSku: line.custom?.sku ?? null,
          tallyUnitPrice: unitPrice, tallyPriceIncludesTax: payload.pricesIncludeTax, tallyClientLineId: line.clientLineId },
        taxRate, discounts: [],
        proratedLinePrice: netShares[index], proratedLinePriceWithTax: grossShares[index],
        discountedLinePrice: netShares[index], discountedLinePriceWithTax: grossShares[index],
        proratedUnitPrice: Math.round(netShares[index] / line.quantity), proratedUnitPriceWithTax: Math.round(grossShares[index] / line.quantity),
        unitPrice, linePrice,
        unitPriceWithTax: payload.pricesIncludeTax ? unitPrice : Math.round(unitPrice * (PERCENT + taxRate) / PERCENT),
        linePriceWithTax: payload.pricesIncludeTax ? linePrice : Math.round(linePrice * (PERCENT + taxRate) / PERCENT),
      };
    });
    return {
      ...summary, active: false, couponCodes: [], discounts: [], fulfillments: [],
      customFields: { ...summary.customFields as Record<string, unknown>, tallyPayments: JSON.stringify(payload.payments), tallyShipping: null,
        tallySnapshot: JSON.stringify({ display: payload.display, taxByRate: payload.taxByRate }) },
      lines, surcharges, shippingLines,
      subTotal: netShares.reduce((sum, share) => sum + share, 0), subTotalWithTax: grossShares.reduce((sum, share) => sum + share, 0),
      shipping: shippingLines.reduce((sum, line) => sum + line.price, 0),
      shippingWithTax: shippingLines.reduce((sum, line) => sum + line.priceWithTax, 0),
      taxSummary: payload.taxByRate?.map(rate => ({ description: rate.code ?? `${rate.ratePpm / PPM_PER_PERCENT}%`,
        taxRate: rate.ratePpm / PPM_PER_PERCENT, taxBase: rate.netMinor, taxTotal: rate.taxMinor }))
        ?? [{ description: 'Tax', taxRate: 0, taxBase: payload.totalMinor - payload.taxMinor, taxTotal: payload.taxMinor }],
      payments: payload.payments.map((payment, index) => ({ id: `${id}-p${index + 1}`, method: DEMO_PAYMENT_METHOD,
        amount: payment.amountMinor, state: 'Settled', transactionId: payment.clientPaymentId, createdAt: payload.createdAt,
        metadata: { tender: payment },
        refunds: this.state.refunds.filter(refund => refund.orderId === id && refund.paymentIndex === index).map(refund => ({
          id: refund.id, total: refund.total, items: refund.total - refund.shipping, shipping: refund.shipping, adjustment: 0,
          state: 'Settled', reason: refund.reason, lines: refund.lines,
          metadata: { tallyMethod: refund.method, tallySessionId: refund.sessionId, tallyClientRefundId: refund.clientRefundId },
        })) })),
    };
  }

  apply(command: Command): CommandResult {
    const { id, type, version, payload: p } = command;
    const refuse = (code: string, message: string, data?: Record<string, unknown>): CommandResult =>
      ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
    const isOrder = type === 'order.create';
    const isRefund = type === 'order.refund';
    const versions = DEMO_INFO.contracts[isOrder ? 'order.create' : isRefund ? 'order.refund' : 'register'];
    if (!versions.includes(version)) return refuse('unsupported_version', isOrder ? 'Unsupported order.create version'
      : `${isRefund ? 'order.refund' : 'register'} version ${version} is not supported; this server supports ${versions.join(', ')}`,
    isOrder ? { orderCreate: Math.max(...versions) } : isRefund ? { orderRefund: Math.max(...versions) } : { register: Math.max(...versions) });
    const content = fingerprint(command);
    const previous = this.state.ledger[id];
    if (previous) return previous.fingerprint !== content
      ? refuse('idempotency_mismatch', 'Command id was already used with a different payload')
      : { ...previous.result, status: previous.result.status === 'rejected' ? 'rejected' : 'duplicate' };
    if (isRefund) {
      const refund = this.refund(p, refuse);
      // A refusal is not recorded, as the plugin's refusals are Unstored: only an applied refund is.
      if ('status' in refund) return refund;
      const result: CommandResult = { id, status: 'applied', refund };
      this.state.ledger[id] = { fingerprint: content, result };
      this.storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(this.state));
      return result;
    }
    let result: CommandResult = { id, status: 'applied' };
    if (isOrder && p.shipping?.length > 1) result = refuse('invalid_payload', 'shipping[1]: shipping_single: this store takes one shipping charge per order');
    if (isOrder && result.status !== 'rejected') {
      for (const field of ['fees', 'shipping', 'lines'] as const) {
        for (const [i, entry] of (p[field] ?? []).entries()) {
          const taxClass = field === 'lines' ? entry.custom?.taxClass : entry.taxClass;
          if (taxClass !== undefined && !DEMO_CATEGORIES.some(category => category.id === taxClass || category.name.toLowerCase() === taxClass.trim().toLowerCase())) {
            const path = `${field}[${i}]${field === 'lines' ? '.custom' : ''}.taxClass`;
            result = refuse('invalid_payload', `${path}: tax_class_unknown: no tax category "${taxClass}" in this store`, { reason: 'tax_class_unknown', path });
            break;
          }
        }
        if (result.status === 'rejected') break;
      }
    }
    if (isOrder && result.status === 'applied') {
      this.state.orders.push(p);
      for (const line of p.lines) {
        if (!line.variantId) continue;
        const stock = this.state.stock[line.variantId];
        if (stock) {
          stock.quantity -= line.quantity;
          stock.updatedAt = nextUpdatedAt(stock.updatedAt);
        }
      }
      const orderId = String(this.state.orders.length);
      result.serverRefs = { orderId, displayId: demoOrderCode(orderId), totalMinor: p.totalMinor };
    } else if (type === 'register.session.open') {
      const winner = Object.values(this.state.sessions).find(session => session.registerId === p.registerId && session.status !== 'closed');
      if (winner) result = refuse('register_session_already_open', `Register ${p.registerId} already has session ${winner.sessionId} open`, { sessionId: winner.sessionId });
      else {
        this.state.sessions[p.sessionId] = { ...p, status: 'open' };
        result.register = { session: this.liveSession(p.sessionId) };
      }
    } else if (type === 'register.closure.submit') {
      const last = this.state.closures.filter(closure => closure.registerId === p.registerId).at(-1);
      const counters = { lastClosureNumber: last?.number ?? 0, perpetualSalesTotalMinor: last?.perpetualSalesTotalMinor ?? 0,
        perpetualRefundsTotalMinor: last?.perpetualRefundsTotalMinor ?? 0 };
      if (p.number !== counters.lastClosureNumber + 1) result = refuse('register_closure_number_invalid',
        `Closure number ${p.number} is not ${counters.lastClosureNumber + 1}`, { counters });
      else {
        const { expected } = this.figures(p.sessionId, p);
        this.state.closures.push(p);
        this.state.sessions[p.sessionId].status = 'closed';
        result.register = {
          closure: { serverClosureId: p.closureId, number: p.number, expected,
            variance: Object.fromEntries(Object.entries(p.counted as Record<string, number>).map(([key, value]) => [key, value - (expected[key] ?? 0)])) },
          counters: { ...counters, lastClosureNumber: p.number, perpetualSalesTotalMinor: p.perpetualSalesTotalMinor,
            perpetualRefundsTotalMinor: p.perpetualRefundsTotalMinor },
        };
      }
    } else if (!isOrder) {
      if (type === 'register.session.transition') this.state.sessions[p.sessionId].status = p.status;
      else this.state.movements.push({ ...p, ...(type === 'register.movement.void' ? { type: 'void', amountMinor: 0 } : {}) });
      result.register = { session: this.liveSession(p.sessionId) };
    }
    this.state.ledger[id] = { fingerprint: content, result };
    this.storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(this.state));
    return result;
  }

  private liveSession(id: string): NonNullable<RegisterCommandResult['session']> {
    return { id, status: this.state.sessions[id].status, ...this.figures(id) };
  }

  private figures(id: string, closure?: RegisterClosureSubmitPayload) {
    const expected: Record<string, number> = { cash: this.state.sessions[id].countedFloatMinor };
    const orders = this.state.orders.filter(order => closure ? closure.orderIds.includes(order.clientOrderId) : order.sessionId === id);
    const movements = this.state.movements.filter(row => row.sessionId === id && (!closure || closure.movementIds.includes(row.movementId)));
    for (const order of orders) for (const payment of order.payments) expected[payment.method] = (expected[payment.method] ?? 0) + payment.amountMinor;
    const voided = new Set(movements.filter(row => row.type === 'void').map(row => row.voids));
    for (const row of movements) if (!voided.has(row.movementId)) {
      if (row.type === 'paid_in') expected.cash += row.amountMinor;
      if (row.type === 'paid_out') expected.cash -= row.amountMinor;
    }
    // The plugin's sessionRefunds: every refund the session made, live or at a closure alike.
    for (const refund of this.state.refunds) if (refund.sessionId === id) expected[refund.method] = (expected[refund.method] ?? 0) - refund.total;
    return { expected, salesCount: orders.length };
  }

  /** order.refund v1 as the plugin's refund.service.ts apply, for one channel and a cashier with every permission. */
  private refund(p: OrderRefundPayload, refuse: (code: string, message: string, data?: Record<string, unknown>) => CommandResult): CommandResult | OrderRefundResult {
    const session = this.state.sessions[p.sessionId];
    if (!session || session.registerId !== p.registerId || session.status === 'closed') return refuse('no_open_session',
      `Session ${p.sessionId} is not open on register ${p.registerId}`, { sessionId: p.sessionId });
    const order = this.order(p.orderId) as RefundableOrder | null;
    if (!order) return refuse('invalid_payload', `orderId: no order ${p.orderId} in this channel`);
    if (p.clientOrderId !== undefined && p.clientOrderId !== order.customFields.tallyClientOrderId) {
      return refuse('invalid_payload', `clientOrderId: order ${p.orderId} is ${order.customFields.tallyClientOrderId}`);
    }
    const earlier = this.state.refunds.find(refund => refund.clientRefundId === p.clientRefundId);
    if (earlier) return refuse('invalid_payload', `clientRefundId: ${p.clientRefundId} is already refund ${earlier.id}`);
    const previous = this.state.refunds.filter(refund => refund.orderId === order.id);
    const lines = [];
    for (const [index, input] of p.lines.entries()) {
      const line = order.lines.find(line => line.id === input.orderLineId);
      if (!line) return refuse('invalid_payload', `lines[${index}].orderLineId: no line ${input.orderLineId} on order ${p.orderId}`);
      lines.push({ input, line });
    }
    type Line = RefundableOrder['lines'][number];
    const refundedOf = (line: Line) => previous.flatMap(refund => refund.lines)
      .filter(refundLine => refundLine.orderLineId === line.id).reduce((sum, refundLine) => sum + refundLine.quantity, 0);
    // ADR 0007: a line's share of its total, so a whole line is the line total and partial refunds add up to it.
    const shareOf = (line: Line, quantity: number) => {
      if (line.quantity === 0) return 0;
      const before = refundedOf(line);
      return Math.round((before + quantity) * line.proratedLinePriceWithTax / line.quantity)
        - Math.round(before * line.proratedLinePriceWithTax / line.quantity);
    };
    const over = lines.map(({ input, line }) => ({
      orderLineId: input.orderLineId, quantity: input.quantity, refundableQuantity: line.quantity - refundedOf(line),
    })).filter(line => line.quantity > line.refundableQuantity);
    if (over.length) return refuse('quantity_exceeds', 'A refunded quantity is more than the line has left to refund', { lines: over });
    const { totalMinor, shippingMinor, adjustmentMinor } = p;
    if (!lines.length && shippingMinor === 0 && adjustmentMinor === 0) return refuse('nothing_to_refund', 'Nothing to refund');
    const refundableShipping = order.shippingWithTax - previous.reduce((sum, refund) => sum + refund.shipping, 0);
    const remainderOf = (index: number) => Math.max(0, order.payments[index].amount - previous
      .filter(refund => refund.paymentIndex === index).reduce((sum, refund) => sum + refund.total, 0));
    const moneyRemainder = order.payments.reduce((sum, _payment, index) => sum + remainderOf(index), 0);
    const raw = lines.reduce((sum, { input, line }) => sum + shareOf(line, input.quantity), 0) + shippingMinor + adjustmentMinor;
    const server = Math.min(Math.max(raw, 0), moneyRemainder);
    if (shippingMinor > refundableShipping || raw !== server || server !== totalMinor) {
      return refuse('amount_mismatch', `Refund total ${totalMinor} does not match the server's ${server}`,
        { expectedMinor: totalMinor, serverMinor: server });
    }
    if (server === 0) return refuse('nothing_to_refund', 'Nothing to refund');

    const refunds: OrderRefundResult['refunds'] = [];
    const byMethod: Record<string, number> = {};
    let left = server;
    for (const [index, payment] of order.payments.entries()) {
      const share = Math.min(left, remainderOf(index));
      if (share === 0) continue;
      const stored: DemoRefund = {
        id: String(this.state.refunds.length + 1), orderId: order.id, paymentIndex: index, total: share,
        shipping: refunds.length ? 0 : shippingMinor,
        lines: refunds.length ? [] : lines.map(({ input }) => ({ orderLineId: input.orderLineId, quantity: input.quantity })),
        reason: p.reason, clientRefundId: p.clientRefundId, sessionId: p.sessionId, method: payment.metadata.tender.method,
      };
      this.state.refunds.push(stored);
      refunds.push({ id: stored.id, paymentId: payment.id, totalMinor: share, state: 'Settled' });
      byMethod[stored.method] = (byMethod[stored.method] ?? 0) + share;
      left -= share;
      if (left === 0) break;
    }
    // Every POS order is fulfilled at create, so the whole refunded quantity goes back to tracked stock.
    for (const { input, line } of lines) {
      const stock = input.restock ? this.state.stock[line.productVariant.id] : undefined;
      if (stock) {
        stock.quantity += input.quantity;
        stock.updatedAt = nextUpdatedAt(stock.updatedAt);
      }
    }
    return { totalMinor: server, byMethod, refunds };
  }
}
