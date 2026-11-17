import { DefaultSearchPlugin, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand, TallyPosPlugin } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

describe('order.create v6 and v7: the sale note', () => {
  const environment = createPluginTestEnvironment({}, [TallyPosPlugin, DefaultSearchPlugin.init({})]);
  const { server, adminClient, variantIds, run } = environment;
  let connection: TransactionalConnection;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
  });
  afterAll(() => server.destroy());
  const sale = (version: number) => ({ ...orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 800 }]), version });
  const send = (command: object) => run(command as unknown as CommandEnvelope<OrderCreatePayload>);
  const notes = async (orderId: string) => {
    const { order } = await adminClient.query<{ order: { history: { items: { type: string; isPublic: boolean; data: unknown }[] } } }>(
      parse('query Notes($id: ID!) { order(id: $id) { history { items { type isPublic data } } } }'), { id: orderId });
    return order.history.items.filter(item => item.type === 'ORDER_NOTE');
  };
  const stored = (id: string) => connection.rawConnection.getRepository(TallyCommand).countBy({ id });

  it('a v7 sale with a note is applied with one public order note, and a replay adds none', async () => {
    const command = sale(7);
    const payload = command.payload as unknown as Record<string, any>;
    payload.note = 'Gift wrap, please';
    const result = await send(command);
    expect(result.status).toBe('applied');
    expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
    const orderId = result.serverRefs!.orderId;
    expect(await notes(orderId)).toEqual([{ type: 'ORDER_NOTE', isPublic: true, data: { note: 'Gift wrap, please' } }]);
    const replay = await send({ ...command, attempt: 2 });
    expect(replay).toMatchObject({ status: 'duplicate', serverRefs: { orderId } });
    expect(await notes(orderId)).toHaveLength(1);
  });

  it('a v7 sale without a note is applied with no order note', async () => {
    const result = await send(sale(7));
    expect(result.status).toBe('applied');
    expect(await notes(result.serverRefs!.orderId)).toEqual([]);
  });

  it('refuses an empty or over-long note, unstored', async () => {
    for (const [note, message] of [['', 'note: expected a non-empty string'], ['x'.repeat(1001), 'note: expected at most 1000 characters']]) {
      const command = sale(7);
      const payload = command.payload as unknown as Record<string, any>;
      payload.note = note;
      const result = await send(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain(message);
      expect(await stored(command.id)).toBe(0);
    }
  });

  it('refuses a note below v7, naming the required version', async () => {
    const command = sale(6);
    const payload = command.payload as unknown as Record<string, any>;
    payload.note = 'Gift wrap, please';
    const result = await send(command);
    expect(result.error!.message).toContain('note: requires order.create version 7, command is version 6');
  });

  it('refuses v6 coupons and Any picks, unstored', async () => {
    for (const field of ['coupons', 'display.coupons', 'lines[0].anyAttributes']) {
      const command = sale(6);
      const payload = command.payload as unknown as Record<string, any>;
      if (field === 'coupons') payload.coupons = [{ code: 'SAVE5', couponId: '1', discountMinor: 0, discountTaxMinor: 0 }];
      else if (field === 'display.coupons') payload.display.coupons = [{ code: 'SAVE5', amountMinor: 0 }];
      else Object.assign(payload.lines[0], { attributes: { Size: 'L' }, anyAttributes: ['Size'] });
      const result = await send(command);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
      expect(result.error!.message).toContain(`${field}: not supported by this server`);
      expect(await stored(command.id)).toBe(0);
    }
  });

  it('applies v6 regular prices and line attributes as display only, at the same total as v5', async () => {
    const command = sale(6);
    const payload = command.payload as unknown as Record<string, any>;
    Object.assign(payload.lines[0], { regularUnitPriceMinor: 1000, attributes: { Colour: 'Blue' } });
    const result = await send(command);
    expect(result.status).toBe('applied');
    expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
    const v5 = await send(sale(5));
    expect(v5.status).toBe('applied');
    expect(v5.serverRefs!.totalMinor).toBe(result.serverRefs!.totalMinor);
    const invalid = sale(6);
    (invalid.payload.lines[0] as unknown as Record<string, any>).regularUnitPriceMinor = -1;
    const refused = await send(invalid);
    expect(refused).toMatchObject({ status: 'rejected', error: { code: 'invalid_payload' } });
    expect(refused.error!.message).toContain('lines[0].regularUnitPriceMinor: expected a non-negative integer');
  });
});
