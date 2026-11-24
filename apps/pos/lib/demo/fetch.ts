/** Requests answered here (connector paths are under @tallyui/connector-vendure/src):
 * Login — auth.ts; apps/pos/lib/sign-in.ts.
 * activeAdministrator (unnamed) — session-probe.ts.
 * StoreSettingsChannel — store-settings.ts; apps/pos/lib/sign-in.ts.
 * StoreSettingsTaxRates — store-settings.ts; apps/pos/lib/sign-in.ts.
 * GlobalStockSettings — global-settings.ts; apps/pos/lib/sign-in.ts.
 * globalSettings (unnamed barcode schema) — apps/pos/lib/barcode-field.ts.
 * AddressCustomFields (none, so the demo keeps the address editor) — apps/pos/lib/customer-edit.ts.
 * logout (unnamed) — apps/pos/lib/logout.ts.
 * GetProducts — replication/products.ts, replication/variant-feed.ts, reconcile/ids.ts, sync/products.ts.
 * GetProductsMark — replication/products.ts.
 * GetProduct — sync/products.ts.
 * GetVariants — replication/variant-feed.ts.
 * GetProductIds — reconcile/ids.ts.
 * products (unnamed total) — apps/pos/lib/store-health.ts.
 * VariantStock — reconcile/stock.ts.
 * GetVariantPrices — reconcile/prices.ts.
 * Search, Create, One — customers.ts.
 * CustomerCustomFieldConfig, CustomerCustomFields — apps/pos/lib/customer-fields.ts.
 * CatalogueChannel, VariantStockLevel, UpdateProductVariants — apps/pos/lib/product-edit.ts.
 * TillPermissions (an older plugin's fallback) — apps/pos/lib/channel-permissions.ts.
 * CollectionImages — apps/pos/lib/collection-categories.ts.
 * Orders, CustomerOrders — orders.ts; apps/pos/lib/order-history.ts.
 * GET /tally/v1/info, with the caller's `permissions` — capabilities.ts; apps/pos/lib/use-sale-settings.ts; apps/pos/lib/channel-permissions.ts.
 * GET /tally/v1/registers — apps/pos/lib/register-choice.ts.
 * GET /tally/v1/registers/:id — apps/pos/lib/closure-history.ts.
 * POST /tally/v1/commands (order.create) — apps/pos/lib/order-transport.ts.
 * POST /tally/v1/commands (register.session.open) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.session.transition) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.movement.record) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.movement.void) — apps/pos/app/index.tsx via order-transport.ts.
 * POST /tally/v1/commands (register.closure.submit) — apps/pos/lib/closure-hold.ts via order-transport.ts.
 * POST /tally/v1/commands (order.refund) — apps/pos/lib/refund-sheet.tsx via till-refund.ts and order-transport.ts.
 * POST /tally/v1/orders/:code/receipt-email — apps/pos/lib/receipt-email.ts.
 * GET /tally/v1/reports/sales/v3 — apps/pos/lib/sales-report.ts via lib/use-store-sales.ts.
 */
import { COMMANDS_PATH } from '@tallyui/core';
import { DEMO_FACETS } from './facets';
import { DEMO_ORDER_HISTORY } from './order-notes';
import { DEMO_CATEGORIES, DEMO_CHANNEL, DEMO_COLLECTION_IMAGES, DEMO_RATES, DemoStore, demoCustomerUser, type DemoStorage } from './store';

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
// The demo's one channel, as the catalogue permissions query names it.
const DEMO_CHANNEL_ID = '1';
// The demo cashier's role on that channel: it sells, reads customers and edits prices and stock (Products panel, CHECKLIST 10.2).
// The demo's till role also approves register variances, so its count shows every figure (ApproveTallyPosVariance unblinds it, lib/register-blind.ts).
// The demo cashier may remove a customer's saved address (10.1n); the plugin's till role may not.
const DEMO_PERMISSIONS = ['Authenticated', 'ReadCatalog', 'UpdateCatalog', 'ReadCustomer', 'CreateCustomer', 'UpdateCustomer', 'ReadOrder', 'ApproveTallyPosVariance', 'DeleteCustomer'];
// The countries the demo store ships to, for the customer address editor's country picker (Admin `countries`).
const DEMO_COUNTRIES = [{ code: 'DE', name: 'Germany' }, { code: 'GB', name: 'United Kingdom' }, { code: 'US', name: 'United States' }];
// Ada's demo tax ID, shown read-only as a Customer custom field.
const DEMO_CUSTOMER_TAX_ID = 'GB123456789';
function demoCustomerFields(customer: { emailAddress: string }): { taxId: string | null; wholesale: boolean } {
  return customer.emailAddress.trim().toLowerCase() === 'ada@demo.vendurepos.com'
    ? { taxId: DEMO_CUSTOMER_TAX_ID, wholesale: true } : { taxId: null, wholesale: false };
}
// e2e only: a till without the approve permission, which counts blind.
export const DEMO_TILL_ROLE_KEY = 'vendurepos.demo.till_role';
// e2e only: an account without TallyPosSell or ReadOrder, which the sales report refuses with 403.
export const DEMO_REPORT_FORBIDDEN_KEY = 'vendurepos.demo.report_forbidden';
// e2e only: the collections read refused with 403, so the category tiles keep no image (CHECKLIST 1.5b).
export const DEMO_COLLECTIONS_REFUSED_KEY = 'vendurepos.demo.collections_refused';
// The plugin's v3 sales report route (reports.controller.ts).
const SALES_REPORT_PATH = '/tally/v1/reports/sales/v3';
// Vendure's Admin GraphQL route.
const ADMIN_PATH = '/admin-api';
// The plugin's capability discovery route.
const INFO_PATH = '/tally/v1/info';
// The plugin's register list (CHECKLIST 6.6).
const REGISTERS_PATH = '/tally/v1/registers';
// The plugin's receipt-email route (CHECKLIST 12.1), with the order code as its one captured segment.
const RECEIPT_EMAIL_ROUTE = /^\/tally\/v1\/orders\/([^/]+)\/receipt-email$/;
// One plain address: no list, space, quote or angle bracket. The plugin's check is stricter (receipt-email.controller.ts EMAIL).
const PLAIN_EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
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
  const fieldValue = (item: Record<string, any>, field: string) => field === 'customerLastName' ? item.customer?.lastName ?? null
    : !(field in item) && field in (item.customFields ?? {}) ? item.customFields[field] : item[field];
  const matches = (item: Record<string, any>, filter: Record<string, any>): boolean => Object.entries(filter).every(([field, rule]) => {
    if (field === '_or') return rule.some((part: Record<string, any>) => matches(item, part));
    const value = fieldValue(item, field);
    return (rule.eq === undefined || value === rule.eq) && (rule.notEq === undefined || value !== rule.notEq) && (!rule.in || rule.in.includes(value))
      && (!rule.after || Date.parse(value) > Date.parse(rule.after)) && (!rule.before || Date.parse(value) < Date.parse(rule.before))
      && (rule.contains === undefined || String(value ?? '').toLowerCase().includes(rule.contains.toLowerCase()))
      && (rule.isNull !== false || value != null);
  });
  const filtered = items.filter(item => matches(item, options.filter ?? {}));
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
  const storage = options.storage ?? globalThis.localStorage ?? memoryStorage;
  const store = new DemoStore(storage);
  // as the plugin's till role, which holds no DeleteCustomer (#358)
  const demoPermissions = () => storage.getItem(DEMO_TILL_ROLE_KEY) === '1'
    ? DEMO_PERMISSIONS.filter(p => p !== 'ApproveTallyPosVariance' && p !== 'DeleteCustomer') : DEMO_PERMISSIONS;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(origin)) return original(input, init);
    const request = new Request(input, init);
    const route = url.slice(origin.length).split('?')[0];
    const reply = (body: unknown, headers?: Record<string, string>, status?: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
    // #487: as the plugin's /info, the caller's own permissions on the active channel.
    if (route === INFO_PATH) return reply({ ...store.info(), permissions: demoPermissions() });
    if (route === REGISTERS_PATH) return reply({ items: store.registers() });
    const search = new URL(url).searchParams;
    const read = route.startsWith(`${REGISTERS_PATH}/`) && store.register(decodeURIComponent(route.slice(REGISTERS_PATH.length + 1)),
      Number(search.get('skip') ?? 0), Number(search.get('take') ?? 20));
    if (read) return reply(read);
    if (route === COMMANDS_PATH) {
      const { commands } = await request.json();
      return reply({ results: commands.map((command: Parameters<DemoStore['apply']>[0]) => store.apply(command)) });
    }
    const receipt = request.method === 'POST' ? RECEIPT_EMAIL_ROUTE.exec(route) : null;
    if (receipt) {
      // The demo sends nothing and keeps no address, not even in demo storage.
      // In the plugin's order: the payload, then the order, then whether a till made it.
      const code = decodeURIComponent(receipt[1]);
      const given = (await request.json().catch(() => null))?.emailAddress;
      const emailAddress = typeof given === 'string' ? given.trim() : '';
      if (!PLAIN_EMAIL.test(emailAddress)) return reply({ code: 'invalid_payload', message: 'Expected a body of { emailAddress }, one email address' }, undefined, 400);
      const order = store.orderSummaries().find(summary => summary.code === code) as { customFields: { tallyClientOrderId: string | null } } | undefined;
      if (!order) return reply({ code: 'order_not_found', message: `No order ${code} in this channel` }, undefined, 404);
      if (!order.customFields.tallyClientOrderId) return reply({ code: 'not_till_order', message: 'Not a till sale' }, undefined, 409);
      return reply({ queued: true, emailAddress }, undefined, 202);
    }
    if (route === SALES_REPORT_PATH) {
      if (storage.getItem(DEMO_REPORT_FORBIDDEN_KEY) === '1') return reply({ code: 'forbidden', message: 'Requires TallyPosSell and ReadOrder' }, undefined, 403);
      const from = search.get('from'), to = search.get('to');
      if (!from || !to) return reply({ code: 'invalid_query', message: 'Expected from and to' }, undefined, 400);
      return reply(store.salesReport({ from, to, timezone: search.get('timezone') ?? 'UTC',
        registerId: search.get('registerId') ?? undefined, cashierId: search.get('cashierId') ?? undefined }));
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
      case 'CustomerList': case 'List': data = { customers: page(store.customerList(), variables.options) }; break;
      case 'Countries': data = { countries: { items: DEMO_COUNTRIES } }; break;
      case 'CreateAddress': data = { createCustomerAddress: store.saveAddress(variables.input, String(variables.customerId)) }; break;
      case 'UpdateAddress': data = { updateCustomerAddress: store.saveAddress(variables.input) }; break;
      case 'CustomerAddressIds': data = { customer: store.customer(String(variables.id)) }; break;
      case 'DeleteCustomerAddress': {
        const removed = store.deleteAddress(String(variables.id));
        if (!removed) return reply({ errors: [{ message: `No Address with the id "${variables.id}" could be found`, extensions: { code: 'ENTITY_NOT_FOUND' } }] });
        data = { deleteCustomerAddress: { success: true } }; break;
      }
      case 'Orders': case 'orders':
        // Detail list queries select lines and payments as well as the summary fields.
        data = { orders: page(store.orderSummaries().map(summary => ({ ...summary, ...store.order(String(summary.id)) })), variables.options) }; break;
      case 'CustomerOrders':
        data = { customer: store.customer(variables.customerId) === null ? null : { orders: page(
          store.orderSummaries().map(summary => ({ ...summary, ...store.order(String(summary.id)) }))
            .filter(row => (row.customer as { id: string } | null)?.id === variables.customerId), variables.options) } }; break;
      case 'Order': case 'order': data = { order: store.order(String(variables.id)) }; break;
      case 'OrderNotes': {
        const id = String(variables.id);
        data = { order: store.order(id) ? { id, history: page(DEMO_ORDER_HISTORY[id] ?? [], variables.options) } : null };
        break;
      }
      case 'CustomerNotes': {
        const id = String(variables.id);
        data = { customer: store.customer(id) ? { id, history: page(store.customerHistory(id), variables.options) } : null };
        break;
      }
      case 'CustomerAccount': { const c = store.customer(String(variables.id)); data = { customer: c ? { id: c.id, user: demoCustomerUser(c) } : null }; break; }
      case 'CustomerCustomFieldConfig': data = { globalSettings: { serverConfig: { entityCustomFields: [{ entityName: 'Customer', customFields: [
        { name: 'taxId', type: 'string', list: false, internal: false, requiresPermission: [], label: [{ languageCode: 'en', value: 'Tax ID' }] },
        { name: 'wholesale', type: 'boolean', list: false, internal: false, requiresPermission: [], label: [{ languageCode: 'en', value: 'Wholesale' }] },
        // A field gated by a permission the demo till lacks, which the sheet leaves out.
        { name: 'creditLimit', type: 'int', list: false, internal: false, requiresPermission: ['SuperAdmin'], label: [{ languageCode: 'en', value: 'Credit limit' }] }] }] } } }; break;
      case 'CustomerCustomFields': { const c = store.customer(String(variables.id)); data = { customer: c ? { id: c.id, customFields: demoCustomerFields(c) } : null }; break; }
      case 'AddCustomerNote': case 'addNoteToCustomer': data = { addNoteToCustomer: store.addCustomerNote(variables.input) }; break;
      case 'Create': case 'createCustomer': data = { createCustomer: store.createCustomer(variables.input) }; break;
      case 'Addresses': data = { customer: store.customer(variables.id) }; break;
      case 'Update': case 'updateCustomer': data = { updateCustomer: store.updateCustomer(variables.input) }; break;
      case 'One': case 'customer': data = { customer: store.customer(variables.id) }; break;
      case 'StoreSettingsChannel': data = { activeChannel: DEMO_CHANNEL, taxCategories: { items: DEMO_CATEGORIES } }; break;
      case 'PublicFacets': case 'facets': data = { facets: page(DEMO_FACETS, variables.options) }; break;
      case 'CollectionImages': case 'collections':
        if (storage.getItem(DEMO_COLLECTIONS_REFUSED_KEY) === '1') {
          // e2e only: counts the refusals, so a test can tell the refused read ran.
          const counter = globalThis as { __demoCollectionsRefused?: number };
          counter.__demoCollectionsRefused = (counter.__demoCollectionsRefused ?? 0) + 1;
          return reply({ errors: [{ message: 'Forbidden' }] }, undefined, 403);
        }
        data = { collections: page(DEMO_COLLECTION_IMAGES, variables.options) }; break;
      case 'StoreSettingsTaxRates': data = { taxRates: { items: DEMO_RATES.filter(rate => rate.zoneId === variables.zoneId) } }; break;
      case 'GlobalStockSettings': case 'globalSettings': case 'AddressCustomFields': data = { globalSettings: {
        trackInventory: true, outOfStockThreshold: 0,
        serverConfig: { customFieldConfig: { Address: [] }, entityCustomFields: [{ entityName: 'ProductVariant', customFields: [{ name: 'barcode', type: 'string', list: false }] }] },
      } }; break;
      case 'GetProduct': case 'product': data = { product: store.products().find(product => product.id === variables.id) ?? null }; break;
      case 'GetProducts': case 'GetProductsMark': case 'GetProductIds': case 'products':
        data = { products: page(store.products(), variables.options) }; break;
      case 'GetVariants': case 'VariantStock': case 'GetVariantPrices': case 'productVariants':
        data = { productVariants: page(store.products().flatMap(product => product.variants), variables.options) }; break;
      case 'CustomerPermissions': case 'CustomerFieldPermissions': case 'CataloguePermissions': case 'RegisterPermissions': case 'TillPermissions':
      case 'CatalogueChannel': data = { me: { channels: [{ id: DEMO_CHANNEL_ID, permissions: demoPermissions() }] }, activeChannel: {
        id: DEMO_CHANNEL_ID, defaultCurrencyCode: DEMO_CHANNEL.defaultCurrencyCode, pricesIncludeTax: DEMO_CHANNEL.pricesIncludeTax } }; break;
      case 'VariantStockLevel': data = { globalSettings: { outOfStockThreshold: 0 },
        productVariant: store.products().flatMap(product => product.variants).find(variant => variant.id === variables.id) ?? null }; break;
      case 'UpdateProductVariants': data = { updateProductVariants: store.updateVariants(variables.input) }; break;
      default: return reply({ errors: [{ message: `Unknown operation: ${operation}` }] });
    }
    return reply({ data: selected(data, fields) }, headers);
  };
  return { uninstall: () => { globalThis.fetch = original; }, reset: () => store.reset() };
}
