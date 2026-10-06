import { randomUUID } from 'node:crypto';
import { DefaultSearchPlugin, Order, ProductVariant, RequestContextService, TaxCategory, TaxRate, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import { TALLY_CUSTOM_ITEM_SKU, TALLY_NO_TAX_CATEGORY } from '../src/service/constants';
import { StoreSetupService } from '../src/service/store-setup.service';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create v5 contract plumbing', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin, DefaultSearchPlugin.init({})]);
  const { server, adminClient, shopClient, variantIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  let category: TaxCategory;
  let standardRate: number;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    category = await connection.rawConnection.getRepository(TaxCategory).findOneByOrFail({ name: 'Standard' });
    standardRate = (await connection.rawConnection.getRepository(TaxRate).findOneOrFail({
      where: { category: { id: category.id }, zone: { name: 'Denmark' } },
    })).value;
  });
  afterAll(() => server.destroy());
  const sale = () => ({ ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version: 5 as const });
  const fee = { clientFeeId: 'fee-1', name: 'Handling', amountMinor: 100, taxStatus: 'none' as const, taxMinor: 0 };
  let defaultCommand: ReturnType<typeof sale>;

  it('applies a plain v5 sale with the same serverRefs total as v4', async () => {
    const v4 = await run({ ...sale(), version: 4 });
    const v5 = await run(sale());
    expect(v4.status).toBe('applied');
    expect(v5.status).toBe('applied');
    expect(v5.serverRefs!.totalMinor).toBe(v4.serverRefs!.totalMinor);
  });

  it('refuses fees below v5, naming the required version', async () => {
    const command = { ...sale(), version: 4 as const };
    command.payload.fees = [fee];
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('fees: requires order.create version 5');
  });

  for (const taxClassMode of ['default', 'none', 'name', 'trimmed-name', 'id', 'unknown'] as const) {
    it(taxClassMode === 'default' ? 'refuses a taxable fee without taxClass when no default category exists'
      : `honours a v5 Bag fee with ${taxClassMode} tax class, or refuses an unknown class`, async () => {
      const command = { ...orderCommand([{
        variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
      }]), version: 5 as const };
      const payload = command.payload;
      const productTotal = payload.totalMinor;
      const taxable = taxClassMode !== 'none';
      const feeTax = taxable ? Math.round(20 * standardRate / 100) : 0;
      const taxClass = taxClassMode === 'name' ? category.name
        : taxClassMode === 'trimmed-name' ? ` ${category.name.toUpperCase()} `
        : taxClassMode === 'id' ? String(category.id)
        : taxClassMode === 'unknown' ? 'missing-tax-category' : undefined;
      payload.fees = [{ ...fee, name: 'Bag', amountMinor: 20, taxStatus: taxable ? 'taxable' : 'none', taxMinor: feeTax, taxClass }];
      payload.taxMinor += feeTax;
      payload.totalMinor += 20 + feeTax;
      payload.payments[0].amountMinor = payload.totalMinor;
      payload.display!.fees = [{ clientFeeId: fee.clientFeeId, amountMinor: 20 }];
      payload.display!.taxMinor = payload.taxMinor;
      payload.display!.totalMinor = payload.totalMinor;
      if (taxable) {
        payload.taxByRate![0].netMinor += 20;
        payload.taxByRate![0].taxMinor += feeTax;
        payload.taxByRate![0].grossMinor += 20 + feeTax;
      } else {
        payload.taxByRate!.push({ ratePpm: 0, netMinor: 20, taxMinor: 0, grossMinor: 20 });
      }
      if (taxClassMode === 'default') {
        expect(await connection.rawConnection.getRepository(TaxCategory).countBy({ isDefault: true })).toBe(0);
        defaultCommand = command;
      }
      const result = await run(command);
      if (taxClassMode === 'unknown' || taxClassMode === 'default') {
        expect(result).toMatchObject({ status: 'rejected', error: {
          code: 'invalid_payload', data: { reason: 'tax_class_unknown', path: 'fees[0].taxClass' },
        } });
        expect(result.error!.message).toContain('fees[0].taxClass');
        expect(result.error!.message).toContain('tax_class_unknown');
        if (taxClassMode === 'default') expect(result.error!.message).toContain('no default tax category');
        return;
      }
      expect(result.status).toBe('applied');
      expect(result.serverRefs!.totalMinor).toBe(payload.totalMinor);
      expect(result.warnings?.some(warning => warning.code === 'figures_mismatch')).not.toBe(true);
      expect(result.totalWarnings ?? []).toEqual([]);
      const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
        where: { id: decode(result.serverRefs!.orderId) }, relations: ['surcharges'],
      });
      expect(order.totalWithTax).toBe(productTotal + 20 + feeTax);
      const surcharges = order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-FEE');
      expect(surcharges).toHaveLength(1);
      expect(surcharges[0]).toMatchObject({ listPrice: 20, description: 'Bag', listPriceIncludesTax: false });
      expect(surcharges[0].taxLines.map(line => line.taxRate)).toEqual(taxable ? [standardRate] : []);
    });
  }

  it('honours golden pair §3.2: product, untaxed Gift wrap and taxable shipping', async () => {
    const command = { ...orderCommand([
      { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000 },
      { custom: { name: 'Gift wrap', taxStatus: 'none' }, quantity: 1, unitPriceMinor: 300, ratePpm: 0 },
    ]), version: 5 as const };
    const payload = command.payload;
    const shippingTax = Math.round(500 * standardRate / 100);
    payload.shipping = [{ clientShippingId: 'shipping-1', name: 'Delivery', amountMinor: 500,
      taxStatus: 'taxable', taxClass: category.name, taxMinor: shippingTax }];
    payload.taxMinor += shippingTax;
    payload.totalMinor += 500 + shippingTax;
    payload.payments[0].amountMinor = payload.totalMinor;
    payload.display!.shipping = [{ clientShippingId: 'shipping-1', amountMinor: 500 }];
    payload.display!.taxMinor = payload.taxMinor;
    payload.display!.totalMinor = payload.totalMinor;
    const taxed = payload.taxByRate!.find(rate => rate.ratePpm === standardRate * 10000)!;
    taxed.netMinor += 500;
    taxed.taxMinor += shippingTax;
    taxed.grossMinor += 500 + shippingTax;
    const result = await run(command);
    expect(result.status).toBe('applied');
    expect(result.serverRefs!.totalMinor).toBe(payload.totalMinor);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.totalWarnings ?? []).toEqual([]);
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'lines.productVariant', 'shippingLines'],
    });
    expect(order.lines).toHaveLength(2);
    const custom = order.lines.find(line => line.productVariant.sku === TALLY_CUSTOM_ITEM_SKU)!;
    expect(custom.customFields).toMatchObject({ tallyCustomName: 'Gift wrap', tallyCustomSku: null });
    expect(custom.linePrice).toBe(300);
    expect(custom.linePriceWithTax).toBe(300);
    expect(custom.taxLines.every(line => line.taxRate === 0)).toBe(true);
    expect(order.shippingLines[0].priceWithTax).toBe(500 + shippingTax);
  });

  it('applies and fulfils a taxable custom-only order', async () => {
    const command = { ...orderCommand([{
      custom: { name: 'Alteration', sku: 'TILL-ALTER', taxStatus: 'taxable', taxClass: category.name },
      quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
    }]), version: 5 as const };
    const result = await run(command);
    expect(result.status).toBe('applied');
    expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.totalWarnings ?? []).toEqual([]);
    const { order } = await adminClient.query(parse(`query Order($id: ID!) {
      order(id: $id) { state fulfillments { state } lines {
        productVariant { sku price } linePrice linePriceWithTax customFields { tallyCustomName tallyCustomSku }
        taxLines { taxRate }
      } }
    }`), { id: result.serverRefs!.orderId });
    expect(order.state).toBe('Delivered');
    expect(order.fulfillments.map((item: { state: string }) => item.state)).toEqual(['Delivered']);
    expect(order.lines).toEqual([{
      productVariant: { sku: TALLY_CUSTOM_ITEM_SKU, price: 0 }, linePrice: 800,
      linePriceWithTax: 800 + Math.round(800 * standardRate / 100),
      taxLines: [{ taxRate: standardRate }],
      customFields: { tallyCustomName: 'Alteration', tallyCustomSku: 'TILL-ALTER' },
    }]);
    expect(order.lines[0].linePriceWithTax - order.lines[0].linePrice).toBe(command.payload.taxMinor);
  });

  it('copies a discounted custom line tax to its TALLY-DISCOUNT surcharge', async () => {
    const command = { ...orderCommand([{
      custom: { name: 'Alteration', taxStatus: 'taxable', taxClass: category.name },
      quantity: 1, unitPriceMinor: 800, discountMinor: 100, ratePpm: standardRate * 10000,
    }]), version: 5 as const };
    const result = await run(command);
    expect(result.status).toBe('applied');
    expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
    expect(result.warnings ?? []).toEqual([]);
    expect(result.totalWarnings ?? []).toEqual([]);
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'surcharges'],
    });
    const discounts = order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-DISCOUNT');
    expect(discounts).toHaveLength(1);
    expect(discounts[0].listPrice).toBe(-100);
    expect(order.lines[0].taxLines.map(line => line.taxRate)).toEqual([standardRate]);
    expect(discounts[0].taxLines).toEqual(order.lines[0].taxLines.map(({ taxRate, description }) => ({ taxRate, description })));
  });

  it('refuses an unknown custom taxClass, naming its path', async () => {
    const command = { ...orderCommand([{
      custom: { name: 'Alteration', taxStatus: 'taxable', taxClass: 'missing-tax-category' },
      quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
    }]), version: 5 as const };
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: {
      code: 'invalid_payload', data: { reason: 'tax_class_unknown', path: 'lines[0].custom.taxClass' },
    } });
    expect(result.error!.message).toContain('lines[0].custom.taxClass: tax_class_unknown');
  });

  it('bootstraps the disabled custom product, channel price and non-default category idempotently', async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const variants = connection.rawConnection.getRepository(ProductVariant);
    const categories = connection.rawConnection.getRepository(TaxCategory);
    const variant = await variants.findOneOrFail({
      where: { sku: TALLY_CUSTOM_ITEM_SKU }, relations: ['product', 'channels', 'productVariantPrices'],
    });
    expect(variant.product.enabled).toBe(false);
    expect(variant.enabled).toBe(true);
    expect(variant.channels.map(channel => String(channel.id))).toContain(String(ctx.channelId));
    expect(variant.productVariantPrices).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: ctx.channelId, price: 0 }),
    ]));
    expect(await categories.findOneByOrFail({ name: TALLY_NO_TAX_CATEGORY })).toMatchObject({ isDefault: false });
    expect(await variants.countBy({ sku: TALLY_CUSTOM_ITEM_SKU })).toBe(1);
    expect(await categories.countBy({ name: TALLY_NO_TAX_CATEGORY })).toBe(1);
    await connection.withTransaction(ctx, tx => server.app.get(StoreSetupService).ensureChannelSetup(tx));
    expect(await variants.countBy({ sku: TALLY_CUSTOM_ITEM_SKU })).toBe(1);
    expect(await categories.countBy({ name: TALLY_NO_TAX_CATEGORY })).toBe(1);
    expect((await variants.findOneByOrFail({ sku: TALLY_CUSTOM_ITEM_SKU })).id).toBe(variant.id);
  });

  it('hides the custom product from Shop API products and search', async () => {
    const variant = await connection.rawConnection.getRepository(ProductVariant).findOneByOrFail({ sku: TALLY_CUSTOM_ITEM_SKU });
    const { products, search } = await shopClient.query(parse(`query {
      products { items { id variants { sku } } }
      search(input: { term: "POS custom item", groupByProduct: true }) { items { productId } }
    }`));
    expect(products.items.map((item: { id: string }) => item.id)).not.toContain(encode(variant.productId));
    expect(products.items.flatMap((item: { variants: Array<{ sku: string }> }) => item.variants.map(value => value.sku)))
      .not.toContain(TALLY_CUSTOM_ITEM_SKU);
    expect(search.items.map((item: { productId: string }) => item.productId)).not.toContain(encode(variant.productId));
  });

  it('refuses a custom line that also has a variantId', async () => {
    const command = sale();
    command.payload.lines[0].custom = { name: 'Custom', taxStatus: 'none' };
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('lines[0].variantId: expected no variantId on a custom line');
  });

  it('refuses negative and fractional fee amounts, naming their path', async () => {
    for (const amountMinor of [-1, 1.5]) {
      const command = sale();
      command.payload.fees = [{ ...fee, amountMinor }];
      const result = await run(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain('fees[0].amountMinor: expected a non-negative integer');
    }
  });

  it('refuses duplicate clientShippingIds', async () => {
    const command = sale();
    const shipping = { clientShippingId: randomUUID(), name: 'Delivery', amountMinor: 100, taxStatus: 'none' as const, taxMinor: 0 };
    command.payload.shipping = [shipping, { ...shipping }];
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(result.error!.message).toContain('shipping[1].clientShippingId: expected no duplicate clientShippingId');
  });

  for (const mode of ['taxable', 'none', 'with-fee'] as const) {
    it(`applies one ${mode} shipping charge as the order's ShippingLine`, async () => {
      const command = { ...orderCommand([{
        variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
      }]), version: 5 as const };
      const payload = command.payload;
      const shippingTax = mode === 'none' ? 0 : Math.round(500 * standardRate / 100);
      const clientShippingId = randomUUID();
      payload.shipping = [{ clientShippingId, name: 'Local delivery', methodId: 'flat_rate',
        amountMinor: 500, taxStatus: mode === 'none' ? 'none' : 'taxable', taxMinor: shippingTax }];
      if (mode === 'with-fee') {
        payload.fees = [fee];
        payload.display!.fees = [{ clientFeeId: fee.clientFeeId, amountMinor: fee.amountMinor }];
        payload.taxByRate!.push({ ratePpm: 0, netMinor: 100, taxMinor: 0, grossMinor: 100 });
      }
      payload.taxMinor += shippingTax;
      payload.totalMinor += 500 + shippingTax + (mode === 'with-fee' ? 100 : 0);
      payload.payments[0].amountMinor = payload.totalMinor;
      payload.display!.shipping = [{ clientShippingId, amountMinor: 500 }];
      payload.display!.taxMinor = payload.taxMinor;
      payload.display!.totalMinor = payload.totalMinor;
      payload.taxByRate!.push({ ratePpm: mode === 'none' ? 0 : standardRate * 10000,
        netMinor: 500, taxMinor: shippingTax, grossMinor: 500 + shippingTax });
      const updateDefault = parse(`mutation SetDefault($id: ID!, $isDefault: Boolean!) {
        updateTaxCategory(input: { id: $id, isDefault: $isDefault }) { id isDefault }
      }`);
      try {
        await adminClient.query(updateDefault, { id: encode(category.id), isDefault: true });
        const result = await run(command);
        expect(result.status).toBe('applied');
        expect(result.serverRefs!.totalMinor).toBe(payload.totalMinor);
        expect(result.warnings?.some(warning => warning.code === 'figures_mismatch')).not.toBe(true);
        expect(result.totalWarnings ?? []).toEqual([]);
        const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
          where: { id: decode(result.serverRefs!.orderId) }, relations: ['shippingLines', 'surcharges'],
        });
        expect(order.shippingLines).toHaveLength(1);
        expect(order.shippingLines[0].price).toBe(500);
        expect(order.shippingLines[0].priceWithTax).toBe(500 + shippingTax);
        expect(order.shippingLines[0].taxLines.map(line => line.taxRate)).toEqual([mode === 'none' ? 0 : standardRate]);
        expect(order.totalWithTax).toBe(payload.totalMinor);
        expect(JSON.parse(order.customFields.tallyShipping!)).toEqual({ clientShippingId, name: 'Local delivery',
          methodId: 'flat_rate', amountMinor: 500, includesTax: false, taxRate: mode === 'none' ? 0 : standardRate });
        expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-FEE').map(surcharge => surcharge.price))
          .toEqual(mode === 'with-fee' ? [100] : []);
      } finally {
        await adminClient.query(updateDefault, { id: encode(category.id), isDefault: false });
      }
    });
  }

  it('refuses two shipping entries, unstored in every version', async () => {
    for (const version of [1, 2, 3, 4, 5] as const) {
      const command = { ...sale(), version };
      command.payload.shipping = [
        { clientShippingId: randomUUID(), name: 'Delivery', amountMinor: 500, taxStatus: 'none', taxMinor: 0 },
        { clientShippingId: randomUUID(), name: 'Second', amountMinor: 100, taxStatus: 'none', taxMinor: 0 },
      ];
      const result = await run(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain('shipping[1]: shipping_single: this store takes one shipping charge per order');
      expect(await connection.rawConnection.getRepository(TallyCommand).countBy({ id: command.id })).toBe(0);
    }
  });

  it('refuses an unknown shipping taxClass', async () => {
    const command = { ...orderCommand([{
      variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800, ratePpm: standardRate * 10000,
    }]), version: 5 as const };
    const payload = command.payload;
    const shippingTax = Math.round(500 * standardRate / 100);
    const clientShippingId = randomUUID();
    payload.shipping = [{ clientShippingId, name: 'Delivery', amountMinor: 500,
      taxStatus: 'taxable', taxClass: 'missing-tax-category', taxMinor: shippingTax }];
    payload.taxMinor += shippingTax;
    payload.totalMinor += 500 + shippingTax;
    payload.payments[0].amountMinor = payload.totalMinor;
    payload.display!.shipping = [{ clientShippingId, amountMinor: 500 }];
    payload.display!.taxMinor = payload.taxMinor;
    payload.display!.totalMinor = payload.totalMinor;
    payload.taxByRate![0].netMinor += 500;
    payload.taxByRate![0].taxMinor += shippingTax;
    payload.taxByRate![0].grossMinor += 500 + shippingTax;
    const result = await run(command);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
      data: { reason: 'tax_class_unknown', path: 'shipping[0].taxClass' } } });
    expect(result.error!.message).toContain('shipping[0].taxClass: tax_class_unknown');
  });

  it('applies and replays a taxable fee without taxClass after setting the default category', async () => {
    const updateDefault = parse(`mutation SetDefault($id: ID!, $isDefault: Boolean!) {
      updateTaxCategory(input: { id: $id, isDefault: $isDefault }) { id isDefault }
    }`);
    try {
      await adminClient.query(updateDefault, { id: encode(category.id), isDefault: true });
      const command = sale();
      command.payload = { ...defaultCommand.payload, clientOrderId: command.payload.clientOrderId };
      const result = await run(command);
      expect(result.status).toBe('applied');
      expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
      expect(result.warnings?.some(warning => warning.code === 'figures_mismatch')).not.toBe(true);
      const replay = await run(command);
      expect(replay.status).toBe('duplicate');
      expect(replay.serverRefs).toEqual(result.serverRefs);
    } finally {
      await adminClient.query(updateDefault, { id: encode(category.id), isDefault: false });
    }
  });
});
