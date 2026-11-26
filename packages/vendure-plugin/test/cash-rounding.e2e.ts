import { PaymentMethod, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginTestEnvironment } from './env';

type Entry = { code: string; name: string; kind: string; rounding?: { incrementMinor: number; mode: string } };

// TallyUI ADR-094: a cash method's roundingIncrement and roundingMode handler args, listed in /info as `rounding`.
describe('cash rounding: method config (ADR-094)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient } = environment;
  let connection: TransactionalConnection;
  let base: string;
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    base = await server.app.getUrl();
    await createMethod('cash-5', { tender: 'cash', roundingIncrement: '5', roundingMode: 'nearest' });
    await createMethod('cash-up', { tender: 'cash', roundingIncrement: '10', roundingMode: 'up' });
    await createMethod('cash-down', { tender: 'cash', roundingIncrement: '5', roundingMode: 'down' });
    await createMethod('cash-nomode', { tender: 'cash', roundingIncrement: '5' });
    await createMethod('cash-oddmode', { tender: 'cash', roundingIncrement: '5', roundingMode: 'sideways' });
    // Stands for a method stored before the rounding args existed: only `tender`.
    await createMethod('cash-absent', { tender: 'cash' });
    for (const increment of ['1', '0', '-5', '2.5', 'abc', '100001', '100000']) {
      await createMethod(`cash-inc-${increment}`, { tender: 'cash', roundingIncrement: increment });
    }
    await createMethod('card-5', { tender: 'card', roundingIncrement: '5' });
    await createMethod('other-5', { tender: 'other', roundingIncrement: '5' });
  });
  afterAll(() => server.destroy());

  async function createMethod(code: string, args: Record<string, string>) {
    await adminClient.query(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code, enabled: true,
      handler: { code: 'tally-pos', arguments: Object.entries(args).map(([name, value]) => ({ name, value })) },
      translations: [{ languageCode: 'en', name: code, description: '' }],
    } });
  }
  const entry = async (code: string): Promise<Entry | undefined> => (await (await fetch(`${base}/tally/v1/info`, {
    headers: { Authorization: `Bearer ${adminClient.getAuthToken()}` } })).json()).paymentMethods.find((method: Entry) => method.code === code);

  it('(a) a cash method with increment 5 and mode nearest lists its rounding', async () => {
    expect(await entry('cash-5')).toEqual({ code: 'cash-5', name: 'cash-5', kind: 'cash', rounding: { incrementMinor: 5, mode: 'nearest' } });
  });

  it('(b) mode up and down are kept; an absent or unknown mode is nearest', async () => {
    expect(await entry('cash-up')).toEqual({ code: 'cash-up', name: 'cash-up', kind: 'cash', rounding: { incrementMinor: 10, mode: 'up' } });
    expect(await entry('cash-down')).toEqual({ code: 'cash-down', name: 'cash-down', kind: 'cash', rounding: { incrementMinor: 5, mode: 'down' } });
    expect(await entry('cash-nomode')).toEqual({ code: 'cash-nomode', name: 'cash-nomode', kind: 'cash', rounding: { incrementMinor: 5, mode: 'nearest' } });
    expect(await entry('cash-oddmode')).toEqual({ code: 'cash-oddmode', name: 'cash-oddmode', kind: 'cash', rounding: { incrementMinor: 5, mode: 'nearest' } });
  });

  it('(c) an absent or unusable increment lists no rounding; the cap 100000 is usable', async () => {
    const stored = await connection.rawConnection.getRepository(PaymentMethod).find();
    const args = (code: string) => stored.find(method => method.code === code)!.handler.args;
    expect(args('cash-absent').map(arg => arg.name)).toEqual(['tender']);
    for (const increment of ['2.5', 'abc']) expect(args(`cash-inc-${increment}`)).toContainEqual({ name: 'roundingIncrement', value: increment });
    for (const code of ['cash-absent', 'cash-inc-1', 'cash-inc-0', 'cash-inc--5', 'cash-inc-2.5', 'cash-inc-abc', 'cash-inc-100001']) {
      expect(await entry(code)).toEqual({ code, name: code, kind: 'cash' });
    }
    expect(await entry('cash-inc-100000')).toEqual({ code: 'cash-inc-100000', name: 'cash-inc-100000', kind: 'cash', rounding: { incrementMinor: 100000, mode: 'nearest' } });
  });

  it('(d) a card or other method with an increment lists no rounding', async () => {
    expect(await entry('card-5')).toEqual({ code: 'card-5', name: 'card-5', kind: 'card' });
    expect(await entry('other-5')).toEqual({ code: 'other-5', name: 'other-5', kind: 'other' });
  });
});
