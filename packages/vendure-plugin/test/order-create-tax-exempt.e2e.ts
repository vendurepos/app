import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TAX_EXEMPT_SUPPORT, TALLY_NO_TAX_CATEGORY } from '../src/service/constants';
import { strictShapeErrors } from '../src/service/strict-shape';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create per-sale tax exemption', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  function mug(version?: 2 | 3) {
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: 0 }],
      undefined, undefined, { version });
    Object.assign(command.payload, { taxExempt: true });
    return command;
  }

  function cart(exempt: boolean) {
    const ratePpm = exempt ? 0 : 250000;
    const command = orderCommand([
      { variantId: variantIds.mug[0], quantity: 2, unitPriceMinor: 800, discountMinor: 100, ratePpm },
      { custom: { name: 'Gift wrap', taxStatus: 'taxable', taxClass: 'Standard' }, quantity: 1, unitPriceMinor: 500, ratePpm },
    ]);
    const { payload } = command;
    if (exempt) Object.assign(payload, { taxExempt: true });
    const charge = { taxStatus: 'taxable' as const, taxClass: 'Standard' };
    payload.fees = [{ ...charge, clientFeeId: 'fee-1', name: 'Handling', amountMinor: 300, taxMinor: exempt ? 0 : 75 }];
    payload.shipping = [{ ...charge, clientShippingId: 'shipping-1', name: 'Delivery', amountMinor: 452, taxMinor: exempt ? 0 : 113 }];
    const display = payload.display!;
    display.fees = [{ clientFeeId: 'fee-1', amountMinor: 300 }];
    display.shipping = [{ clientShippingId: 'shipping-1', amountMinor: 452 }];
    const rate = payload.taxByRate![0];
    for (const { amountMinor, taxMinor } of [...payload.fees, ...payload.shipping]) {
      rate.netMinor += amountMinor;
      rate.taxMinor += taxMinor;
      rate.grossMinor += amountMinor + taxMinor;
      payload.taxMinor += taxMinor;
      payload.totalMinor += amountMinor + taxMinor;
    }
    display.taxMinor = payload.taxMinor;
    display.totalMinor = payload.totalMinor;
    payload.payments[0].amountMinor = payload.totalMinor;
    return { ...command, version: 11 } as unknown as ReturnType<typeof orderCommand>;
  }

  const readOrder = (id: string) => connection.rawConnection.getRepository(Order).findOneOrFail({
    where: { id: decode(id) }, relations: ['lines', 'shippingLines', 'surcharges', 'payments'],
  });

  it('E1: an exempt sale carries zero tax on every line, fee and shipping, and totals the untaxed subtotal', async () => {
    const result = await run(cart(true));
    expect(result).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 2752 } });
    expect(result.warnings ?? []).toEqual([]);
    expect(result.totalWarnings ?? []).toEqual([]);
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.total).toBe(2752);
    expect(order.totalWithTax).toBe(2752);
    expect(order.lines).toHaveLength(2);
    for (const line of order.lines) expect(line.linePriceWithTax).toBe(line.linePrice);
    expect(order.surcharges.map(charge => charge.sku).sort()).toEqual(['TALLY-DISCOUNT', 'TALLY-FEE']);
    expect(order.shippingLines).toHaveLength(1);
    for (const charge of [...order.surcharges, ...order.shippingLines]) expect(charge.priceWithTax).toBe(charge.price);
    for (const row of order.taxSummary) expect(row.taxTotal).toBe(0);
  });

  it('E2: the same cart without taxExempt is taxed (control)', async () => {
    const result = await run(cart(false));
    expect(result).toMatchObject({ status: 'applied' });
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax - order.total).toBe(688);
    expect(order.totalWithTax).toBe(3440);
  });

  it('E3: exempt at versions 2 and 3 is applied untaxed', async () => {
    for (const command of [mug(2), mug()]) {
      const result = await run(command);
      expect(result).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 800 } });
      expect(result.warnings ?? []).toEqual([]);
      const order = await readOrder(result.serverRefs!.orderId);
      expect(order.totalWithTax).toBe(order.total);
    }
  });

  it('E4: an exempt sale in prices-include-tax mode is refused unstored', async () => {
    const command = mug();
    command.payload.pricesIncludeTax = true;
    expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
      message: 'pricesIncludeTax: expected false on a tax-exempt order' } });
    command.payload.pricesIncludeTax = false;
    expect(await run(command)).toMatchObject({ status: 'applied' });
  });

  it('E5: an exempt sale with an inclusive line, fee or shipping charge is refused', async () => {
    for (const group of ['lines', 'fees', 'shipping'] as const) {
      const command = cart(true);
      const field = group === 'lines' ? 'taxInclusive' : 'amountIncludesTax';
      Object.assign(command.payload[group]![0], { [field]: true });
      expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
        message: `${group}[0].${field}: expected not true on a tax-exempt order` } });
    }
  });

  it('E6: an exempt sale carrying any non-zero tax figure is refused', async () => {
    for (const group of ['', 'fees', 'shipping', 'taxByRate', 'display'] as const) {
      const command = cart(true);
      const row = group === '' ? command.payload : group === 'display' ? command.payload.display! : command.payload[group]![0];
      row.taxMinor = 1;
      const prefix = group === '' ? '' : group === 'display' ? 'display.' : `${group}[0].`;
      expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
        message: `${prefix}taxMinor: expected 0 on a tax-exempt order` } });
    }
  });

  it('E7: taxExempt other than true is refused', async () => {
    const command = mug();
    Object.assign(command.payload, { taxExempt: false });
    expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
      message: 'taxExempt: expected true when present' } });
  });

  it('E8: an exempt sale with coupons is refused', async () => {
    const command = cart(true);
    Object.assign(command.payload, { coupons: [{ code: 'SAVE' }] });
    expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
      message: 'coupons: not supported by this server; taxExempt with coupons: not supported by this server' } });
  });

  it('E9: an exempt sale the store would tax is refused store_configuration, unstored', async () => {
    type NamedList = { items: Array<{ id: string; name: string }> };
    const { taxCategories, zones } = await adminClient.query<{ taxCategories: NamedList; zones: NamedList }>(parse(`query {
      taxCategories { items { id name } } zones { items { id name } }
    }`));
    const { createTaxRate } = await adminClient.query<{ createTaxRate: { id: string } }>(parse(`mutation Rate($input: CreateTaxRateInput!) {
      createTaxRate(input: $input) { id }
    }`), { input: { name: 'Tax on POS no tax', enabled: true, value: 10, categoryId: taxCategories.items.find(row => row.name === TALLY_NO_TAX_CATEGORY)!.id,
      zoneId: zones.items.find(row => row.name === 'Denmark')!.id } });
    const command = mug();
    try {
      expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'store_configuration',
        message: `Tax-exempt order ${command.payload.clientOrderId} would carry tax 80: the "${TALLY_NO_TAX_CATEGORY}" tax category has a rate in this zone` } });
    } finally {
      const updated = await adminClient.query(parse(`mutation Disable($id: ID!) {
        updateTaxRate(input: { id: $id, enabled: false }) { id enabled }
      }`), { id: createTaxRate.id });
      expect(updated).toMatchObject({ updateTaxRate: { enabled: false } });
      const deleted = await adminClient.query(parse(`mutation Delete($id: ID!) { deleteTaxRate(id: $id) { result } }`), { id: createTaxRate.id });
      expect(deleted).toMatchObject({ deleteTaxRate: { result: 'DELETED' } });
    }
    expect(await run(command)).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 800 } });
  });

  it('E10: an applied exempt sale replays unchanged', async () => {
    const command = mug();
    const result = await run(command);
    expect(result).toMatchObject({ status: 'applied' });
    expect(await run(command)).toEqual({ ...result, status: 'duplicate' });
  });

  it('E11: /info declares the tax-exempt support constant', async () => {
    const info = async () => {
      const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, { headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(TAX_EXEMPT_SUPPORT).toEqual({ taxExempt: true, taxExemptCoupons: false });
    expect(await info()).toMatchObject(TAX_EXEMPT_SUPPORT);
    const declared = { ...TAX_EXEMPT_SUPPORT };
    try {
      Object.assign(TAX_EXEMPT_SUPPORT, { taxExempt: false });
      expect(await info()).toMatchObject(TAX_EXEMPT_SUPPORT);
    } finally {
      Object.assign(TAX_EXEMPT_SUPPORT, declared);
    }
  });

  it('C1: the order.create gate reads the supported argument, not its own constant', () => {
    const command = { ...cart(true) };
    expect(strictShapeErrors(command, 11, { taxExempt: false, taxExemptCoupons: false })).toContain('taxExempt: not supported by this server');
    expect(strictShapeErrors(command, 11, TAX_EXEMPT_SUPPORT)).toEqual([]);
  });
});
