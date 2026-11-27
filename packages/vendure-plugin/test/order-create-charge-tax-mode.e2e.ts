import { randomUUID } from 'node:crypto';
import { Order, Refund, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Charge = { amountMinor: number; amountIncludesTax?: boolean; net: number; gross: number };
const inclusiveFee = { amountMinor: 1002, amountIncludesTax: true, net: 802, gross: 1002 };
const net500 = { amountMinor: 500, net: 500, gross: 625 };

describe('order.create per-charge tax mode', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, variantIds, decode, encode, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    await adminClient.query(parse(`mutation Stock($input: [UpdateProductVariantInput!]!) {
      updateProductVariants(input: $input) { id }
    }`), { input: [{ id: variantIds.mug[0], stockOnHand: 100 }] });
  });
  afterAll(() => server.destroy());

  function sale({ fee, shipping, pricesIncludeTax = false }: { fee?: Charge; shipping?: Charge; pricesIncludeTax?: boolean }) {
    const command = { ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: pricesIncludeTax ? 1000 : 800 }],
      undefined, undefined, { pricesIncludeTax }), version: 5 as const };
    const { payload } = command;
    const display = payload.display!;
    for (const [kind, charge] of [['fees', fee], ['shipping', shipping]] as const) {
      if (!charge) continue;
      const { amountMinor, amountIncludesTax, net, gross } = charge;
      const taxMinor = gross - net;
      const name = kind === 'fees' ? 'Handling' : 'Delivery';
      const clientId = randomUUID();
      const item = { name, amountMinor, ...(amountIncludesTax === undefined ? {} : { amountIncludesTax }), taxMinor,
        ...(taxMinor ? { taxClass: 'Standard', taxStatus: 'taxable' as const } : { taxStatus: 'none' as const }) };
      const displayAmount = pricesIncludeTax ? gross : net;
      if (kind === 'fees') {
        payload.fees = [{ ...item, clientFeeId: clientId }];
        display.fees = [{ clientFeeId: clientId, amountMinor: displayAmount }];
      } else {
        payload.shipping = [{ ...item, clientShippingId: clientId }];
        display.shipping = [{ clientShippingId: clientId, amountMinor: displayAmount }];
      }
      if (taxMinor) {
        const standard = payload.taxByRate![0];
        standard.netMinor += net;
        standard.taxMinor += taxMinor;
        standard.grossMinor += gross;
      } else {
        payload.taxByRate!.push({ ratePpm: 0, netMinor: net, taxMinor, grossMinor: gross });
      }
      payload.taxMinor += taxMinor;
      payload.totalMinor += gross;
    }
    display.taxMinor = payload.taxMinor;
    display.totalMinor = payload.totalMinor;
    payload.payments[0].amountMinor = payload.totalMinor;
    return command;
  }

  const readOrder = (id: string) => connection.rawConnection.getRepository(Order).findOneOrFail({
    where: { id: decode(id) }, relations: ['lines', 'shippingLines', 'surcharges', 'payments'],
  });
  async function exact(command: ReturnType<typeof sale>) {
    const result = await run(command);
    expect(result).toMatchObject({ status: 'applied', serverRefs: { totalMinor: command.payload.totalMinor } });
    expect(result.totalWarnings ?? []).toEqual([]);
    expect(result.warnings?.some(warning => warning.code === 'figures_mismatch')).not.toBe(true);
    const order = await readOrder(result.serverRefs!.orderId);
    expect(order.totalWithTax).toBe(command.payload.totalMinor);
    expect(order.surcharges.filter(charge => charge.sku === 'TALLY-ROUNDING')).toHaveLength(0);
    return order;
  }
  function expectFee(order: Order, listPrice: number, listPriceIncludesTax: boolean, price: number, priceWithTax: number) {
    const fees = order.surcharges.filter(charge => charge.sku === 'TALLY-FEE');
    expect(fees).toMatchObject([{ listPrice, listPriceIncludesTax, price, priceWithTax }]);
    return fees[0];
  }
  function expectShipping(order: Order, listPrice: number, listPriceIncludesTax: boolean, discountedPrice: number, priceWithTax: number) {
    expect(order.shippingLines).toMatchObject([{ listPrice, listPriceIncludesTax, discountedPrice, priceWithTax }]);
    expect(JSON.parse(order.customFields.tallyShipping!).includesTax).toBe(listPriceIncludesTax);
  }

  it('C1: keeps the gross fee in an exclusive sale', async () => {
    const order = await exact(sale({ fee: inclusiveFee }));
    expectFee(order, 1002, true, 802, 1002);
    expect(order.totalWithTax).toBe(2002);
  });

  it('C2: keeps gross shipping in an exclusive sale', async () => {
    const order = await exact(sale({ shipping: inclusiveFee }));
    expectShipping(order, 1002, true, 802, 1002);
    expect(order.totalWithTax).toBe(2002);
  });

  it('C3: the fee override does not affect the shipping default', async () => {
    const order = await exact(sale({ fee: inclusiveFee, shipping: net500 }));
    expectFee(order, 1002, true, 802, 1002);
    expectShipping(order, 500, false, 500, 625);
    expect(order.totalWithTax).toBe(2627);
  });

  it('C4: explicit false overrides an inclusive sale', async () => {
    const order = await exact(sale({ pricesIncludeTax: true, fee: { amountMinor: 800, amountIncludesTax: false, net: 800, gross: 1000 } }));
    expectFee(order, 800, false, 800, 1000);
  });

  it('C5: an untaxed inclusive fee stays untaxed', async () => {
    const order = await exact(sale({ fee: { ...inclusiveFee, net: 1002 } }));
    expect(expectFee(order, 1002, true, 1002, 1002).taxLines).toEqual([]);
  });

  it('C6: explicit false and no override store identical fee figures in an exclusive sale', async () => {
    for (const fee of [{ ...net500, amountIncludesTax: false }, net500]) {
      const order = await exact(sale({ fee }));
      expectFee(order, 500, false, 500, 625);
      expect(order.totalWithTax).toBe(1625);
    }
  });

  it('C7: both tender legs settle as sent', async () => {
    const command = sale({ fee: inclusiveFee });
    command.payload.payments[0].amountMinor = 1000;
    command.payload.payments.push({ clientPaymentId: randomUUID(), method: 'external', amountMinor: 1002 });
    const order = await exact(command);
    expectFee(order, 1002, true, 802, 1002);
    expect(order.payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(2002);
    for (const tender of command.payload.payments) {
      expect(order.payments.find(payment => payment.metadata.tender.clientPaymentId === tender.clientPaymentId))
        .toMatchObject({ amount: tender.amountMinor, state: 'Settled', metadata: { tender } });
    }
  });

  it('C8: only the cash surcharge changes the exact goods total', async () => {
    await adminClient.query(parse(`mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), {
      input: { code: 'cash-5', enabled: true, handler: { code: 'tally-pos', arguments: [
        { name: 'tender', value: 'cash' }, { name: 'roundingIncrement', value: '5' }, { name: 'roundingMode', value: 'nearest' },
      ] }, translations: [{ languageCode: 'en', name: 'cash-5', description: '' }] },
    });
    const command = sale({ fee: inclusiveFee });
    const { payload } = command;
    Object.assign(payload, { cashRoundings: [{ paymentId: payload.payments[0].clientPaymentId, minor: -2 }] });
    payload.payments[0].amountMinor = payload.display!.totalMinor = payload.totalMinor = 2000;
    const order = await exact(command);
    expectFee(order, 1002, true, 802, 1002);
    const cash = order.surcharges.filter(charge => charge.sku === 'TALLY-CASH-ROUNDING');
    expect(cash).toMatchObject([{ priceWithTax: -2 }]);
    expect(order.totalWithTax - cash[0].priceWithTax).toBe(2002);
  });

  it('C9: a full refund returns the line and the gross fee, without rounding', async () => {
    const order = await exact(sale({ fee: inclusiveFee }));
    const fee = expectFee(order, 1002, true, 802, 1002);
    const session = { sessionId: randomUUID(), registerId: randomUUID() };
    const createdAt = new Date().toISOString();
    const post = async (type: string, payload: object) => {
      const response = await fetch(`${await server.app.getUrl()}/tally/v1/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tally-Protocol': '1', Authorization: `Bearer ${adminClient.getAuthToken()}` },
        body: JSON.stringify({ commands: [{ id: randomUUID(), type, version: 1, createdAt, deviceId: 'refund-till', attempt: 1, payload }] }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).results[0];
    };
    expect(await post('register.session.open', { ...session, openedAt: createdAt, countedFloatMinor: 0 })).toMatchObject({ status: 'applied' });
    const result = await post('order.refund', { ...session, clientRefundId: randomUUID(), createdAt, orderId: encode(order.id),
      lines: order.lines.map(line => ({ orderLineId: encode(line.id), quantity: line.quantity, restock: true })),
      shippingMinor: 0, adjustmentMinor: fee.priceWithTax, totalMinor: 2002, destination: 'original_method', reason: 'Full refund',
    });
    expect(result).toMatchObject({ status: 'applied', refund: { totalMinor: 2002, refunds: [{ totalMinor: 2002, state: 'Settled' }] } });
    const refund = await connection.rawConnection.getRepository(Refund).findOneByOrFail({ id: decode(result.refund.refunds[0].id) });
    expect(refund.total).toBe(order.lines[0].proratedLinePriceWithTax + fee.priceWithTax);
    expect(refund.metadata).not.toHaveProperty('tallyCashRoundingMinor');
  });

  it('C10: legacy converted net still needs the minus-one bridge', async () => {
    const command = sale({ fee: { amountMinor: 802, net: 802, gross: 1002 } });
    const result = await run(command);
    expect(result).toMatchObject({ status: 'applied', serverRefs: { totalMinor: 2002 }, totalWarnings: [
      { code: 'total_mismatch', expectedMinor: 2002, serverMinor: 2003, bridgeMinor: -1 },
    ] });
    // app#528 half 2: the bridged total is in `warnings` too.
    expect(result.warnings).toContainEqual({ code: 'total_mismatch', expectedMinor: 2002, serverMinor: 2003, bridgeMinor: -1 });
    const order = await readOrder(result.serverRefs!.orderId);
    expectFee(order, 802, false, 802, 1003);
    expect(order.surcharges.filter(charge => charge.sku === 'TALLY-ROUNDING')).toMatchObject([{ priceWithTax: -1 }]);
  });

  it('C11: changing only the mode conflicts with the stored fingerprint', async () => {
    const command = sale({ fee: inclusiveFee });
    expectFee(await exact(command), 1002, true, 802, 1002);
    Object.assign(command.payload.fees![0], { amountIncludesTax: false });
    expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'idempotency_mismatch' } });
  });

  for (const field of ['fees', 'shipping'] as const) {
    it.each(['yes', 1, null])(`C13: rejects ${field}[0].amountIncludesTax = %j without an order`, async value => {
      const command = sale(field === 'fees' ? { fee: inclusiveFee } : { shipping: inclusiveFee });
      Object.assign(command.payload[field]![0], { amountIncludesTax: value });
      expect(await run(command)).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload',
        message: `${field}[0].amountIncludesTax: expected a boolean` } });
      expect(await connection.rawConnection.getRepository(Order).countBy({ customFields: { tallyClientOrderId: command.payload.clientOrderId } })).toBe(0);
    });
  }

  it('C14: advertises chargeTaxMode v1', async () => {
    const response = await fetch(`${await server.app.getUrl()}/tally/v1/info`, { headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).chargeTaxMode).toEqual({ v: 1 });
  });
});
