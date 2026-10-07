/** Requests answered here (connector paths are under @tallyui/connector-vendure/src):
 * Login — auth.ts; apps/pos/lib/sign-in.ts.
 * activeAdministrator (unnamed) — session-probe.ts.
 * StoreSettingsChannel — store-settings.ts; apps/pos/lib/sign-in.ts.
 * StoreSettingsTaxRates — store-settings.ts; apps/pos/lib/sign-in.ts.
 * GlobalStockSettings — global-settings.ts; apps/pos/lib/sign-in.ts.
 * globalSettings (unnamed barcode schema) — apps/pos/lib/barcode-field.ts.
 * logout (unnamed) — apps/pos/lib/logout.ts.
 * GetProducts — replication/products.ts, replication/variant-feed.ts, reconcile/ids.ts, sync/products.ts.
 * GetProductsMark — replication/products.ts.
 * GetProduct — sync/products.ts.
 * GetVariants — replication/variant-feed.ts.
 * GetProductIds — reconcile/ids.ts.
 * VariantStock — reconcile/stock.ts.
 * GetVariantPrices — reconcile/prices.ts.
 * Search, Create, One — customers.ts.
 * Orders — orders.ts; apps/pos/lib/order-history.ts.
 * GET /tally/v1/info — capabilities.ts; apps/pos/lib/use-sale-settings.ts.
 * POST /tally/v1/commands (order.create) — apps/pos/lib/order-transport.ts.
 * POST /tally/v1/commands (register.session.open) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.session.transition) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.movement.record) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.movement.void) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.closure.submit) — apps/pos/lib/closure-hold.ts via order-transport.ts.
 */
import { COMMANDS_PATH } from '@tallyui/core';
import { DEMO_CATEGORIES, DEMO_CHANNEL, DEMO_INFO, DEMO_RATES, DemoStore, type DemoStorage } from './store';

// Reserved, non-resolving origin: a request missed by the wrapper cannot reach a live store.
export const DEMO_STORE_ORIGIN = 'https://demo-store.vendurepos.invalid';
// Public demo cashier, shown on /demo and accepted only by the installed in-process store.
export const DEMO_CREDENTIALS = { email: 'cashier@demo.vendurepos.com', password: 'demo1234' };
// The simulated store's display name on /demo.
export const DEMO_STORE_NAME = 'VendurePOS demo store';
// The demo's only channel is the shop floor, so sign-in needs no channel token.
export const DEMO_CHANNEL_TOKEN = undefined;
// Bearer token returned in Vendure's login response header.
const DEMO_AUTH_TOKEN = 'demo-session';
// Stable administrator identity for the login and session probe.
const ADMINISTRATOR_ID = '1';
// Vendure's Admin GraphQL route.
const ADMIN_PATH = '/admin-api';
// The plugin's capability discovery route.
const INFO_PATH = '/tally/v1/info';
// Unrecognised REST routes return the server's not-found status.
const NOT_FOUND = 404;
// Memory storage is shared across installations when localStorage is absent.
const memory = new Map<string, string>();
// The same one-key storage interface is used in browsers, tests and memory-only environments.
const memoryStorage: DemoStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); },
};

type Selection = { [field: string]: Selection | null };
/** Read the selections used by the connector, including the login and custom-field inline fragments. */
function selections(query: string): Selection {
  const source = query.replace(/#[^\n]*/g, '').replace(/\([^)]*\)/g, '');
  const tokens = source.slice(source.indexOf('{')).match(/\.\.\.|[A-Za-z_]\w*|[{}]/g) ?? [];
  let index = 0;
  function read(): Selection {
    const fields: Selection = {};
    index++;
    while (index < tokens.length && tokens[index] !== '}') {
      const field = tokens[index++];
      if (field === '...') { index += 2; Object.assign(fields, read()); }
      else fields[field] = tokens[index] === '{' ? read() : null;
    }
    index++;
    return fields;
  }
  return read();
}

function selected(value: any, fields: Selection): any {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => selected(item, fields));
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key in value)
    .map(([key, children]) => [key, children ? selected(value[key], children) : value[key]]));
}

function page(items: Record<string, any>[], options: any = {}) {
  const filtered = items.filter(item => Object.entries(options.filter ?? {}).every(([field, condition]) => {
    const rule = condition as { eq?: string; in?: string[]; after?: string; before?: string };
    return (rule.eq === undefined || item[field] === rule.eq) && (!rule.in || rule.in.includes(item[field]))
      && (!rule.after || Date.parse(item[field]) > Date.parse(rule.after)) && (!rule.before || Date.parse(item[field]) < Date.parse(rule.before));
  }));
  filtered.sort((a, b) => {
    for (const [field, direction] of Object.entries(options.sort ?? { id: 'ASC' })) {
      const difference = String(a[field]).localeCompare(String(b[field]), 'en', { numeric: true });
      if (difference) return direction === 'DESC' ? -difference : difference;
    }
    return 0;
  });
  const skip = options.skip ?? 0;
  return { items: filtered.slice(skip, options.take === undefined ? undefined : skip + options.take), totalItems: filtered.length };
}

export function installDemoStore(origin: string, options: { storage?: DemoStorage } = {}): { uninstall(): void; reset(): void } {
  const original = globalThis.fetch;
  const store = new DemoStore(options.storage ?? globalThis.localStorage ?? memoryStorage);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(origin)) return original(input, init);
    const request = new Request(input, init);
    const route = url.slice(origin.length).split('?')[0];
    const reply = (body: unknown, headers?: Record<string, string>, status?: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
    if (route === INFO_PATH) return reply(DEMO_INFO);
    if (route === COMMANDS_PATH) {
      const { commands } = await request.json();
      return reply({ results: commands.map((command: Parameters<DemoStore['apply']>[0]) => store.apply(command)) });
    }
    if (route !== ADMIN_PATH) return reply({ statusCode: NOT_FOUND, message: `Cannot ${request.method} ${route}`, error: 'Not Found' }, undefined, NOT_FOUND);
    const { query, variables = {}, operationName } = await request.json();
    const fields = selections(query);
    const operation = operationName ?? /\b(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(query)?.[1] ?? Object.keys(fields)[0];
    let data: Record<string, any>;
    let headers: Record<string, string> | undefined;
    switch (operation) {
      case 'Login': case 'login': {
        const valid = variables.email === DEMO_CREDENTIALS.email && variables.password === DEMO_CREDENTIALS.password;
        data = { login: valid ? { __typename: 'CurrentUser', id: ADMINISTRATOR_ID }
          : { __typename: 'InvalidCredentialsError', errorCode: 'INVALID_CREDENTIALS_ERROR', message: 'The provided credentials are invalid' } };
        if (valid) headers = { 'vendure-auth-token': DEMO_AUTH_TOKEN };
        break;
      }
      case 'activeAdministrator': data = { activeAdministrator: request.headers.get('Authorization') === `Bearer ${DEMO_AUTH_TOKEN}` ? { id: ADMINISTRATOR_ID } : null }; break;
      case 'logout': data = { logout: { success: true } }; break;
      case 'Search': case 'customers': data = { customers: store.customers(variables) }; break;
      case 'Orders': case 'orders': data = { orders: page(store.orderSummaries(), variables.options) }; break;
      case 'Create': case 'createCustomer': data = { createCustomer: store.createCustomer(variables.input) }; break;
      case 'One': case 'customer': data = { customer: store.customer(variables.id) }; break;
      case 'StoreSettingsChannel': data = { activeChannel: DEMO_CHANNEL, taxCategories: { items: DEMO_CATEGORIES } }; break;
      case 'StoreSettingsTaxRates': data = { taxRates: { items: DEMO_RATES.filter(rate => rate.zoneId === variables.zoneId) } }; break;
      case 'GlobalStockSettings': case 'globalSettings': data = { globalSettings: {
        trackInventory: true, outOfStockThreshold: 0,
        serverConfig: { entityCustomFields: [{ entityName: 'ProductVariant', customFields: [{ name: 'barcode', type: 'string', list: false }] }] },
      } }; break;
      case 'GetProduct': case 'product': data = { product: store.products().find(product => product.id === variables.id) ?? null }; break;
      case 'GetProducts': case 'GetProductsMark': case 'GetProductIds': case 'products':
        data = { products: page(store.products(), variables.options) }; break;
      case 'GetVariants': case 'VariantStock': case 'GetVariantPrices': case 'productVariants':
        data = { productVariants: page(store.products().flatMap(product => product.variants), variables.options) }; break;
      default: return reply({ errors: [{ message: `Unknown operation: ${operation}` }] });
    }
    return reply({ data: selected(data, fields) }, headers);
  };
  return { uninstall: () => { globalThis.fetch = original; }, reset: () => store.reset() };
}
