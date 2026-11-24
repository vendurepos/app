import { AddressBasedTaxZoneStrategy, DefaultSearchPlugin, Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// 5.2a: order.create 11 stores the customer's billing and shipping addresses on the order, never on the customer's
// saved addresses, and refuses a sale whose address would move it out of the tax zone the till priced it in.
type Customer = OrderCreatePayload['customer'] & { billing?: object; shipping?: object };
type Address = { fullName: string | null; streetLine1: string | null; city: string | null; postalCode: string | null; countryCode: string | null };
type ReadOrder = { totalWithTax: number; taxSummary: { taxRate: number }[]; billingAddress: Address; shippingAddress: Address };
const ADDRESS_FIELDS = 'fullName streetLine1 city postalCode countryCode';
const ORDER_QUERY = parse(`query Order($id: ID!) { order(id: $id) { totalWithTax taxSummary { taxRate }
  billingAddress { ${ADDRESS_FIELDS} } shippingAddress { ${ADDRESS_FIELDS} } } }`);
const DE = { firstName: 'Ada', lastName: 'Lovelace', address1: 'Hauptstr. 1', city: 'Berlin', postcode: '10115', country: 'DE' };
const DK = { firstName: 'Ada', lastName: 'Lovelace', address1: 'Nyhavn 1', city: 'København', postcode: '1051', country: 'DK' };
const stored = (address: typeof DE): Address => ({ fullName: 'Ada Lovelace', streetLine1: address.address1, city: address.city,
  postalCode: address.postcode, countryCode: address.country });
const EMPTY: Address = { fullName: null, streetLine1: null, city: null, postalCode: null, countryCode: null };

function setup(environment: ReturnType<typeof createPluginTestEnvironment>) {
  const { server, adminClient, variantIds, run } = environment;
  type Lines = Parameters<typeof orderCommand>[0];
  const sale = (version: number, customer?: Customer,
    lines: Lines = [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]) => ({ ...orderCommand(lines,
    undefined, customer as OrderCreatePayload['customer']), version }) as unknown as CommandEnvelope<OrderCreatePayload>;
  const send = (command: CommandEnvelope<OrderCreatePayload>, attempt = 1) => run({ ...command, attempt });
  const connection = () => server.app.get(TransactionalConnection).rawConnection;
  const counts = async (id: string) => ({ orders: await connection().getRepository(Order).count(),
    commands: await connection().getRepository(TallyCommand).countBy({ id }) });
  const readOrder = async (id: string) => (await adminClient.query<{ order: ReadOrder }>(ORDER_QUERY, { id })).order;
  return { sale, send, counts, readOrder };
}

describe('order.create v11, default tax zone strategy', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin, DefaultSearchPlugin.init({})]);
  const { server, adminClient } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());
  const { sale, send, counts, readOrder } = setup(environment);
  // Refused invalid_payload, unstored, and a second send gets the same answer.
  async function expectRefused(command: CommandEnvelope<OrderCreatePayload>, message: string) {
    const before = await counts(command.id);
    for (const attempt of [1, 2]) {
      const result = await send(command, attempt);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain(message);
      expect(await counts(command.id)).toEqual(before);
    }
  }
  const addressed = (address: object) => sale(11, { email: 'f@example.com', shipping: address });

  it('(a) a v10 sale with no addresses is applied with empty addresses; a v10 customer.billing is still not supported', async () => {
    const result = await send(sale(10, { email: 'a@example.com' }));
    expect(result.status).toBe('applied');
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(1000);
    expect([order.billingAddress, order.shippingAddress]).toEqual([EMPTY, EMPTY]);
    await expectRefused(sale(10, { email: 'a@example.com', billing: DE }), 'customer.billing: not supported by this server');
  });

  it('(b) a v11 sale with no addresses is applied at the v10 total', async () => {
    const result = await send(sale(11, { email: 'b@example.com' }));
    expect(result.status).toBe('applied');
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(1000);
    expect(order.taxSummary.map(row => row.taxRate)).toEqual([25, 0]);
    expect([order.billingAddress, order.shippingAddress]).toEqual([EMPTY, EMPTY]);
  });

  it('(c) a v11 sale with a DE billing and a DK shipping address is applied at 25% with both addresses stored', async () => {
    const result = await send(sale(11, { email: 'c@example.com', billing: DE, shipping: DK }));
    expect(result.status, JSON.stringify(result)).toBe('applied');
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(1000);
    // The mug at Denmark's 25%, as in (b); the 0 row is the POS shipping line every sale carries.
    expect(order.taxSummary.map(row => row.taxRate)).toEqual([25, 0]);
    expect(order.billingAddress).toEqual(stored(DE));
    expect(order.shippingAddress).toEqual(stored(DK));
  });

  it('(d) a v11 sale never changes the customer\'s saved addresses', async () => {
    type Saved = { addresses: { streetLine1: string; city: string; country: { code: string } }[] };
    const result = await send(sale(11, { email: 'd-new@example.com', billing: DE, shipping: DE }));
    expect(result.status).toBe('applied');
    const { customers } = await adminClient.query<{ customers: { items: Saved[] } }>(parse(`query { customers(options: {
      filter: { emailAddress: { eq: "d-new@example.com" } } }) { items { addresses { streetLine1 city country { code } } } } }`));
    expect(customers.items).toEqual([{ addresses: [] }]);

    const { createCustomer } = await adminClient.query<{ createCustomer: { id: string } }>(parse(`mutation {
      createCustomer(input: { emailAddress: "d-saved@example.com", firstName: "Ada", lastName: "Lovelace" }) { ... on Customer { id } } }`));
    await adminClient.query(parse(`mutation Add($id: ID!) { createCustomerAddress(customerId: $id,
      input: { streetLine1: "Nyhavn 1", city: "København", countryCode: "DK" }) { id } }`), { id: createCustomer.id });
    const saved = async () => (await adminClient.query<{ customer: Saved }>(parse(`query Saved($id: ID!) { customer(id: $id) {
      addresses { streetLine1 city country { code } } } }`), { id: createCustomer.id })).customer.addresses;
    const original = await saved();
    expect(original).toEqual([{ streetLine1: 'Nyhavn 1', city: 'København', country: { code: 'DK' } }]);
    const second = await send(sale(11, { customerId: createCustomer.id, shipping: DE }));
    expect(second.status, JSON.stringify(second)).toBe('applied');
    expect((await readOrder(second.serverRefs!.orderId)).shippingAddress).toEqual(stored(DE));
    expect(await saved()).toEqual(original);
  });

  it('(e) a walk-in v11 sale with a shipping address is applied with the address on the order', async () => {
    const result = await send(sale(11, { shipping: DE }));
    expect(result.status, JSON.stringify(result)).toBe('applied');
    expect((await readOrder(result.serverRefs!.orderId)).shippingAddress).toEqual(stored(DE));
  });

  it('(f) an unknown address key is refused invalid_payload, unstored', async () => {
    await expectRefused(addressed({ ...DE, zip: '10115' }), 'customer.shipping.zip: unknown field in order.create version 11');
  });

  it('(f) a non-string address field is refused invalid_payload, unstored', async () => {
    await expectRefused(addressed({ ...DE, city: 42 }), 'customer.shipping.city: expected a string');
  });

  it('(f) a 256-character city is refused invalid_payload, unstored', async () => {
    await expectRefused(addressed({ ...DE, city: 'x'.repeat(256) }), 'customer.shipping.city: expected at most 255 characters');
  });

  it('(f) an address with no country is refused invalid_payload, unstored', async () => {
    const { country: _country, ...noCountry } = DE;
    await expectRefused(addressed(noCountry), 'customer.shipping.country: expected a country code');
  });

  it('(f) taxAddress at v11 is refused invalid_payload, unstored', async () => {
    const command = sale(11, { email: 'f@example.com' });
    (command.payload as unknown as Record<string, unknown>).taxAddress = 'shipping';
    await expectRefused(command, 'taxAddress: not supported by this server');
  });

  it('(g) an unknown country is refused invalid_payload country_unknown and writes no order', async () => {
    const command = addressed({ ...DE, country: 'XX' });
    const before = await counts(command.id);
    const result = await send(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
      message: 'customer.shipping.country: country_unknown: no country "XX" in this store',
      data: { reason: 'country_unknown', path: 'customer.shipping.country' } } });
    expect((await counts(command.id)).orders).toBe(before.orders);
  });
});

describe('order.create v11, AddressBasedTaxZoneStrategy', () => {
  const environment = createPluginTestEnvironment({ taxOptions: { taxZoneStrategy: new AddressBasedTaxZoneStrategy() } },
    [TallyPosPlugin, DefaultSearchPlugin.init({})]);
  const { server, variantIds } = environment;
  beforeAll(() => environment.init());
  afterAll(() => server.destroy());
  const { sale, send, counts, readOrder } = setup(environment);

  it('(h) a v11 sale with a DK shipping address is applied at 1000 with the address stored', async () => {
    const result = await send(sale(11, { email: 'h@example.com', shipping: DK }));
    expect(result.status, JSON.stringify(result)).toBe('applied');
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(1000);
    expect(order.taxSummary.map(row => row.taxRate)).toEqual([25, 0]);
    expect(order.shippingAddress).toEqual(stored(DK));
  });

  it('(i) a v11 sale with a DE shipping address is refused tax_zone_mismatch, unstored, and the v10 sale is applied', async () => {
    const command = sale(11, { email: 'i@example.com', shipping: DE });
    const before = await counts(command.id);
    for (const attempt of [1, 2]) {
      const result = await send(command, attempt);
      expect(result).toMatchObject({ status: 'rejected',
        error: { code: 'tax_zone_mismatch', data: { tillZone: 'Denmark', addressZone: 'Germany' } } });
      expect(await counts(command.id)).toEqual({ orders: before.orders, commands: 0 });
    }
    const v10 = await send(sale(10, { email: 'i@example.com' }));
    expect(v10.status).toBe('applied');
    expect((await readOrder(v10.serverRefs!.orderId)).totalWithTax).toBe(1000);
  });

  it('(j) a v11 sale with a tax-inclusive line and a DE shipping address is refused tax_zone_mismatch, though its total is the same in both zones', async () => {
    // Inclusive, the total is 1000 in either zone, so only the guard stops Germany's 19% replacing Denmark's 25%.
    const lines = [{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 1000, taxInclusive: true }];
    const command = sale(11, { email: 'j@example.com', shipping: DE }, lines);
    const before = await counts(command.id);
    const result = await send(command);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'rejected',
      error: { code: 'tax_zone_mismatch', data: { tillZone: 'Denmark', addressZone: 'Germany' } } });
    expect(await counts(command.id)).toEqual({ orders: before.orders, commands: 0 });
    const v10 = await send(sale(10, undefined, lines));
    expect(v10.status, JSON.stringify(v10)).toBe('applied');
    expect((await readOrder(v10.serverRefs!.orderId)).totalWithTax).toBe(1000);
  });
});
