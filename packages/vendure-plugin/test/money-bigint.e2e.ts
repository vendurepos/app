import { BigIntMoneyStrategy, Order, Payment, TransactionalConnection } from '@vendure/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

// N2: the money limits follow the store. With BigIntMoneyStrategy the money columns are bigint, so
// only unitPriceMinor (an `int` custom field) and quantity keep the int4 cap.
describe('a store with BigIntMoneyStrategy', () => {
  const environment = createPluginTestEnvironment({ entityOptions: { moneyStrategy: new BigIntMoneyStrategy() } });
  const { server, variantIds, decode, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());

  it('applies a sale above int4 on every money field but unitPriceMinor', async () => {
    // 10 x 2 000 000 000 less a 3 000 000 000 discount, at 25%: net 17e9, tax 4.25e9, total 21.25e9.
    const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 10, unitPriceMinor: 2_000_000_000, discountMinor: 3_000_000_000 }]);
    const { payload } = command;
    for (const value of [payload.totalMinor, payload.subtotalMinor, payload.taxMinor, payload.discountMinor, payload.payments[0].amountMinor]) {
      expect(value).toBeGreaterThan(2_147_483_647);
    }
    const result = await run(command);
    expect(result, JSON.stringify(result)).toMatchObject({ id: command.id, status: 'applied', serverRefs: { totalMinor: 21_250_000_000 } });
    const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
      where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'surcharges'],
    });
    expect(order.state).toBe('Delivered');
    expect(order.totalWithTax).toBe(21_250_000_000);
    expect(order.surcharges.map(surcharge => surcharge.listPrice)).toEqual([-3_000_000_000]);
    const payments = await connection.rawConnection.getRepository(Payment).find({ where: { order: { id: order.id } } });
    expect(payments.map(payment => [payment.amount, payment.state])).toEqual([[21_250_000_000, 'Settled']]);
  });

  it('still refuses unitPriceMinor and quantity above int4 (invalid_payload, invalid_quantity), and money above the safe range', async () => {
    const mug = { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 };
    const cases: Array<[string, (command: ReturnType<typeof orderCommand>) => void]> = [
      ['invalid_payload', command => { command.payload.lines[0].unitPriceMinor = 2_147_483_648; }],
      ['invalid_quantity', command => { command.payload.lines[0].quantity = 2_147_483_648; }],
      ['invalid_payload', command => { command.payload.totalMinor = Number.MAX_SAFE_INTEGER + 1; }],
    ];
    for (const [code, mutate] of cases) {
      const command = orderCommand([mug]);
      mutate(command);
      expect(await run(command)).toMatchObject({ status: 'rejected', error: { code } });
    }
  });
});
