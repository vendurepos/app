import type { CommandResult, OrderCreatePayload, RegisterClosureSubmitPayload, RegisterCommandResult, RegisterSessionOpenPayload } from '@tallyui/core';
import { barcodeOf, CATALOGUE } from './catalogue';

// All mutable demo data is saved together, including the command ledger.
export const DEMO_STORAGE_KEY = 'vendurepos.demo-store.v1';
// Matches info.controller.ts with the dev store's OrderLevelTaxCalculationStrategy.
export const DEMO_INFO = {
  contracts: { 'order.create': [1, 2, 3, 4], register: [1] },
  taxRounding: { granularity: 'per_rate_group_items', mode: 'half_up' },
};
// The demo exposes the seed's tax-exclusive EUR shop-floor channel.
export const DEMO_CHANNEL = { defaultCurrencyCode: 'EUR', pricesIncludeTax: false, defaultTaxZone: { id: 'DE' } };
// Category ids shared by settings, rates and variant reads.
export const DEMO_CATEGORIES = [{ id: '1', name: 'Standard', isDefault: true }, { id: '2', name: 'Reduced', isDefault: false }];
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

export type DemoStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Command = { id: string; type: string; version: number; payload: any };
type Session = RegisterSessionOpenPayload & { status: 'open' | 'counting' | 'closed' };
type Movement = { movementId: string; sessionId: string; type: string; amountMinor: number; voids?: string };
type Customer = { __typename: 'Customer'; id: string; firstName: string; lastName: string; emailAddress: string; phoneNumber: string | null };
type State = {
  customers: Customer[];
  stock: Record<string, { quantity: number; updatedAt: string }>;
  ledger: Record<string, { fingerprint: string; result: CommandResult }>;
  orders: OrderCreatePayload[]; sessions: Record<string, Session>;
  movements: Movement[]; closures: RegisterClosureSubmitPayload[];
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
  ].map(([firstName, lastName, emailAddress], index) => ({
    __typename: 'Customer', id: `c${index + 1}`, firstName, lastName, emailAddress, phoneNumber: null,
  }));
  return { stock, ledger: {}, orders: [], sessions: {}, movements: [], closures: [], customers };
}

/** Canonical command content, like the plugin's fingerprint, without its Node-only SHA-256 import. */
function fingerprint({ type, version, payload }: Command): string {
  return JSON.stringify({ type, version, payload }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export class DemoStore {
  private state: State;
  constructor(private storage?: DemoStorage) {
    const saved = storage?.getItem(DEMO_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved); // State saved before customers existed gets the seeded ones.
      this.state = { ...parsed, customers: Array.isArray(parsed.customers) ? parsed.customers : seed().customers };
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
    return CATALOGUE.map((product, index) => ({
      id: String(index + 1), createdAt: SEED_TIME, updatedAt: SEED_TIME,
      name: product.name, slug: product.slug, description: `${product.name} (VendurePOS dev seed)`, enabled: true,
      featuredAsset: null, assets: [], collections: [], facetValues: [],
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

  apply(command: Command): CommandResult {
    const { id, type, version, payload: p } = command;
    const refuse = (code: string, message: string, data?: Record<string, unknown>): CommandResult =>
      ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
    const isOrder = type === 'order.create';
    const versions = DEMO_INFO.contracts[isOrder ? 'order.create' : 'register'];
    if (!versions.includes(version)) return refuse('unsupported_version', isOrder ? 'Unsupported order.create version'
      : `register version ${version} is not supported; this server supports ${versions.join(', ')}`,
    isOrder ? { orderCreate: Math.max(...versions) } : { register: Math.max(...versions) });
    const content = fingerprint(command);
    const previous = this.state.ledger[id];
    if (previous) return previous.fingerprint !== content
      ? refuse('idempotency_mismatch', 'Command id was already used with a different payload')
      : { ...previous.result, status: previous.result.status === 'rejected' ? 'rejected' : 'duplicate' };
    let result: CommandResult = { id, status: 'applied' };
    if (isOrder) {
      this.state.orders.push(p);
      for (const line of p.lines) {
        const stock = this.state.stock[line.variantId];
        if (stock) {
          stock.quantity -= line.quantity;
          stock.updatedAt = new Date(Math.max(Date.now(), Date.parse(stock.updatedAt) + 1)).toISOString();
        }
      }
      const orderId = String(this.state.orders.length);
      result.serverRefs = { orderId, displayId: `DEMO-${orderId.padStart(6, '0')}`, totalMinor: p.totalMinor };
    } else if (type === 'register.session.open') {
      const winner = Object.values(this.state.sessions).find(session => session.registerId === p.registerId && session.status !== 'closed');
      if (winner) result = refuse('register_session_already_open', `Register ${p.registerId} already has session ${winner.sessionId} open`, { sessionId: winner.sessionId });
      else {
        this.state.sessions[p.sessionId] = { ...p, status: 'open' };
        result.register = { session: this.liveSession(p.sessionId) };
      }
    } else if (type === 'register.closure.submit') {
      const last = this.state.closures.filter(closure => closure.registerId === p.registerId).at(-1);
      const counters = { lastClosureNumber: last?.number ?? 0, perpetualSalesTotalMinor: last?.perpetualSalesTotalMinor ?? 0, perpetualRefundsTotalMinor: 0 };
      if (p.number !== counters.lastClosureNumber + 1) result = refuse('register_closure_number_invalid',
        `Closure number ${p.number} is not ${counters.lastClosureNumber + 1}`, { counters });
      else {
        const { expected } = this.figures(p.sessionId, p);
        this.state.closures.push(p);
        this.state.sessions[p.sessionId].status = 'closed';
        result.register = {
          closure: { serverClosureId: p.closureId, number: p.number, expected,
            variance: Object.fromEntries(Object.entries(p.counted as Record<string, number>).map(([key, value]) => [key, value - (expected[key] ?? 0)])) },
          counters: { ...counters, lastClosureNumber: p.number, perpetualSalesTotalMinor: p.perpetualSalesTotalMinor },
        };
      }
    } else {
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
    return { expected, salesCount: orders.length };
  }
}
