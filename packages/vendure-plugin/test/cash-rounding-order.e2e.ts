import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TallyCommand } from '../src';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

type Tender = { methodId?: string; method: 'cash' | 'external'; amountMinor: number };
type Entry = { index: number; minor: number };
type AdminOrder = {
  totalWithTax: number;
  surcharges: Array<{ sku: string; price: number; priceWithTax: number; taxLines: Array<{ taxRate: number }> }>;
  payments: Array<{ amount: number; method: string }>;
};
type RefusalCode = 'invalid_payload' | 'total_mismatch';

const cash5 = (amountMinor: number): Tender => ({ methodId: 'cash-5', method: 'cash', amountMinor });
const card = (amountMinor: number): Tender => ({ methodId: 'card', method: 'external', amountMinor });
const cash5down = (amountMinor: number): Tender => ({ methodId: 'cash-5-down', method: 'cash', amountMinor });
const DEFAULTS = { 'cash-5': true, 'cash-10': false, 'cash-5-up': false, 'cash-5-down': false };

// TallyUI ADR-094 P1b: order.create's cashRoundings, checked against the channel's rounding cash methods and stored as
// one untaxed TALLY-CASH-ROUNDING surcharge, so Vendure's total is what the till took.
describe('cash rounding: order.create (ADR-094 P1b)', () => {
  const environment = createPluginTestEnvironment();
  const { server, adminClient, run } = environment;
  let connection: TransactionalConnection;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    await environment.init();
    connection = server.app.get(TransactionalConnection);
    await createMethod('cash-5', true, { tender: 'cash', roundingIncrement: '5', roundingMode: 'nearest' });
    await createMethod('cash-10', false, { tender: 'cash', roundingIncrement: '10', roundingMode: 'nearest' });
    await createMethod('cash-5-up', false, { tender: 'cash', roundingIncrement: '5', roundingMode: 'up' });
    await createMethod('cash-5-down', false, { tender: 'cash', roundingIncrement: '5', roundingMode: 'down' });
    await createMethod('card', true, { tender: 'card' });
  });
  afterAll(() => server.destroy());

  async function createMethod(code: string, enabled: boolean, args: Record<string, string>) {
    const { createPaymentMethod } = await adminClient.query<{ createPaymentMethod: { id: string } }>(parse(`
      mutation Create($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`), { input: {
      code, enabled,
      handler: { code: 'tally-pos', arguments: Object.entries(args).map(([name, value]) => ({ name, value })) },
      translations: [{ languageCode: 'en', name: code, description: '' }],
    } });
    ids[code] = createPaymentMethod.id;
  }
  const setEnabled = (code: string, enabled: boolean) => adminClient.query(parse(`
    mutation Update($input: UpdatePaymentMethodInput!) { updatePaymentMethod(input: $input) { id } }`), { input: { id: ids[code], enabled } });
  async function withMethods(enabled: Partial<typeof DEFAULTS>, body: () => Promise<void>) {
    try {
      for (const [code, value] of Object.entries(enabled)) await setEnabled(code, value);
      await body();
    } finally {
      for (const [code, value] of Object.entries(DEFAULTS)) await setEnabled(code, value);
    }
  }

  const send = (command: object) => run(command as unknown as CommandEnvelope<OrderCreatePayload>);
  const payloadOf = (command: { payload: unknown }) => command.payload as Record<string, any>;
  /** A sale of one untaxed custom line of U, paid by `payments`, with `entries` as its cashRoundings; the goods figures
   * (subtotal, tax, taxByRate) stay as the till sends them, and only the totals carry the rounding. */
  function roundedSale(U: number, payments: Tender[], entries: Entry[], version = 10,
    totalMinor = U + entries.reduce((sum, entry) => sum + entry.minor, 0)) {
    const command = { ...orderCommand([{ custom: { name: 'Item', taxStatus: 'none' }, quantity: 1, unitPriceMinor: U, ratePpm: 0 }]), version };
    const payload = payloadOf(command);
    payload.payments = payments.map(({ methodId, ...tender }) => ({
      clientPaymentId: orderCommand([]).id, ...tender, ...(version >= 10 && methodId ? { methodId } : {}),
    }));
    if (entries.length) {
      payload.cashRoundings = entries.map(({ index, minor }) => ({ paymentId: payload.payments[index].clientPaymentId, minor }));
    }
    payload.totalMinor = totalMinor;
    payload.display.totalMinor = totalMinor;
    return command;
  }
  const ordersOf = (command: { payload: unknown }) => connection.rawConnection.getRepository(Order)
    .count({ where: { customFields: { tallyClientOrderId: payloadOf(command).clientOrderId } } });
  const stored = (id: string) => connection.rawConnection.getRepository(TallyCommand).countBy({ id });

  // Refused, unstored and with no order; a second send gets the same answer.
  async function expectRefused(command: ReturnType<typeof roundedSale>, code: RefusalCode, message?: string) {
    let first: unknown;
    for (const attempt of [1, 2]) {
      const result = await send({ ...command, attempt });
      expect(result).toMatchObject({ status: 'rejected', error: { code } });
      if (message) expect(result.error!.message).toContain(message);
      if (attempt === 1) first = result.error;
      else expect(result.error).toEqual(first);
      expect(await stored(command.id)).toBe(0);
      expect(await ordersOf(command)).toBe(0);
    }
    return first as { code: string; message: string; data?: Record<string, unknown> };
  }

  // Row 28 on every applied row: order.totalWithTax == payload.totalMinor == Σ Payment.amount.
  async function expectApplied(command: ReturnType<typeof roundedSale>, cashMinor: number) {
    const result = await send(command);
    expect(result.status, JSON.stringify(result.error)).toBe('applied');
    const { order } = await adminClient.query<{ order: AdminOrder }>(parse(`query Order($id: ID!) { order(id: $id) {
      totalWithTax surcharges { sku price priceWithTax taxLines { taxRate } } payments { amount method } } }`), { id: result.serverRefs!.orderId });
    const payload = payloadOf(command);
    expect(order.totalWithTax).toBe(payload.totalMinor);
    expect(order.payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(payload.totalMinor);
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-CASH-ROUNDING'))
      .toEqual(cashMinor ? [{ sku: 'TALLY-CASH-ROUNDING', price: cashMinor, priceWithTax: cashMinor, taxLines: [] }] : []);
    expect(order.surcharges.filter(surcharge => surcharge.sku === 'TALLY-ROUNDING')).toEqual([]);
    const sorted = (payments: Array<{ amount: number; method: string }>) => [...payments].sort((a, b) => a.amount - b.amount || a.method.localeCompare(b.method));
    expect(sorted(order.payments)).toEqual(sorted((payload.payments as Array<Tender & { clientPaymentId: string }>)
      .map(payment => ({ amount: payment.amountMinor, method: payment.methodId ?? 'tally-pos' }))));
    return { result, order };
  }

  describe('(a) one cash leg', () => {
    it('row 1, 29: rounded up, one untaxed surcharge of +2, total 1005, no warnings', async () => {
      const { result } = await expectApplied(roundedSale(1003, [cash5(1005)], [{ index: 0, minor: 2 }]), 2);
      expect(result.warnings).toBeUndefined();
      expect(result.totalWarnings).toBeUndefined();
    });

    it('row 2, 29: rounded down, surcharge −2, total 1000, no warnings', async () => {
      const { result } = await expectApplied(roundedSale(1002, [cash5(1000)], [{ index: 0, minor: -2 }]), -2);
      expect(result.warnings).toBeUndefined();
      expect(result.totalWarnings).toBeUndefined();
    });
  });

  describe('(b) splits', () => {
    it('row 3: card 500 and cash-5 505, total 1005', async () => {
      await expectApplied(roundedSale(1003, [card(500), cash5(505)], [{ index: 1, minor: 2 }]), 2);
    });

    it('row 4: two cash legs with two entries make exactly one surcharge of −4', async () => {
      await expectApplied(roundedSale(1004, [cash5(500), cash5(500)], [{ index: 0, minor: -2 }, { index: 1, minor: -2 }]), -4);
    });

    it('row 5: card only with no cashRoundings is applied as today, with no cash surcharge', async () => {
      const command = roundedSale(1003, [card(1003)], []);
      expect(payloadOf(command).cashRoundings).toBeUndefined();
      await expectApplied(command, 0);
    });
  });

  describe('(c) write-offs', () => {
    it('row 6: a write-off on a card leg', async () => {
      await expectApplied(roundedSale(1002, [card(1000)], [{ index: 0, minor: -2 }]), -2);
    });

    it('row 7: a write-off on a cash leg after a card', async () => {
      await expectApplied(roundedSale(1002, [card(500), cash5(500)], [{ index: 1, minor: -2 }]), -2);
    });

    it('row 8: a write-off with only a mode-up method enabled', async () => {
      await withMethods({ 'cash-5': false, 'cash-5-up': true }, async () => {
        await expectApplied(roundedSale(1002, [card(1000)], [{ index: 0, minor: -2 }]), -2);
      });
    });

    it('row 9: a write-off of exactly half an increment, only cash-10 enabled', async () => {
      await withMethods({ 'cash-5': false, 'cash-10': true }, async () => {
        await expectApplied(roundedSale(1005, [card(1000)], [{ index: 0, minor: -5 }]), -5);
      });
    });

    it('row 10: a write-off with no rounding method enabled is refused', async () => {
      await withMethods({ 'cash-5': false, 'cash-10': false, 'cash-5-up': false }, async () => {
        await expectRefused(roundedSale(1002, [card(1000)], [{ index: 0, minor: -2 }]), 'invalid_payload', 'cashRoundings');
      });
    });

    it('row 11: two write-offs on non-rounding legs are refused', async () => {
      await expectRefused(roundedSale(1004, [card(500), card(500)], [{ index: 0, minor: -2 }, { index: 1, minor: -2 }]),
        'invalid_payload', 'cashRoundings[1]: an entry on a payment that is not a rounding cash method must be a single negative write-off');
    });

    it('row 12: a positive entry on a card leg is refused', async () => {
      await expectRefused(roundedSale(1003, [card(1005)], [{ index: 0, minor: 2 }]), 'invalid_payload',
        'cashRoundings[0]: an entry on a payment that is not a rounding cash method must be a single negative write-off');
    });
  });

  describe('(d) the till\'s merged entries', () => {
    it('row 13: void then settle on cash (#1364), surcharge +2', async () => {
      await expectApplied(roundedSale(1003, [cash5(1000), cash5(5)], [{ index: 0, minor: -2 }, { index: 1, minor: 4 }]), 2);
    });

    it('row 14: a pick and a write-off merged on one cash leg', async () => {
      await expectApplied(roundedSale(503, [cash5(500)], [{ index: 0, minor: -3 }]), -3);
    });

    it('row 15: a card write-off not on the last leg', async () => {
      await expectApplied(roundedSale(1003, [card(6), card(993)], [{ index: 0, minor: -4 }]), -4);
    });

    it('row 16: the #1295 sale, surcharge −1', async () => {
      await expectApplied(roundedSale(1008, [card(497), cash5(510)], [{ index: 0, minor: -3 }, { index: 1, minor: 2 }]), -1);
    });
  });

  describe('(e) the bound (F5)', () => {
    it('row 17: six void cycles (TallyUI#1365) are refused total_mismatch with the figures', async () => {
      const error = await expectRefused(roundedSale(52, [cash5(40)], [{ index: 0, minor: -12 }]), 'total_mismatch', 'TallyUI#1365');
      expect(error.data).toEqual({ cashRoundingMinor: -12, boundMinor: 10 });
    });

    it('row 18: an entry inside the bound is applied', async () => {
      await expectApplied(roundedSale(1009, [cash5(1000)], [{ index: 0, minor: -9 }]), -9);
    });

    it('row 19: an entry at the bound is refused total_mismatch', async () => {
      await expectRefused(roundedSale(1010, [cash5(1000)], [{ index: 0, minor: -10 }]), 'total_mismatch');
    });

    it('row 20: the bound follows the largest enabled increment', async () => {
      await withMethods({ 'cash-10': true }, async () => {
        await expectApplied(roundedSale(52, [cash5(40)], [{ index: 0, minor: -12 }]), -12);
      });
    });
  });

  describe('(f) amounts', () => {
    it('row 21: payments that do not add up to totalMinor are refused', async () => {
      await expectRefused(roundedSale(1003, [cash5(1010)], [{ index: 0, minor: 2 }]), 'invalid_payload',
        'cashRoundings: the payments must add up to totalMinor exactly when the order carries cash rounding');
    });

    it('row 22: a goods total more than the bridge bound off the server\'s is refused total_mismatch', async () => {
      const error = await expectRefused(roundedSale(1003, [cash5(1010)], [{ index: 0, minor: 2 }], 10, 1010), 'total_mismatch');
      expect(error.data).toMatchObject({ expectedMinor: 1008, serverMinor: 1003, bridgeMinor: 5 });
    });

    it('row 23: a cash leg that is not a multiple of its increment is refused', async () => {
      await expectRefused(roundedSale(1003, [card(1), cash5(1004)], [{ index: 1, minor: 2 }]), 'invalid_payload', 'payments[1].amountMinor');
    });
  });

  describe('(g) entry shapes and content versions', () => {
    it('row 24: each malformed entry is refused, unstored, naming its path', async () => {
      const cases: Array<[string, (payload: Record<string, any>) => void]> = [
        ['cashRoundings: expected an array of at most 16', payload => {
          payload.cashRoundings = Array.from({ length: 17 }, () => ({ ...payload.cashRoundings[0] }));
        }],
        ['cashRoundings[1].paymentId', payload => { payload.cashRoundings.push({ ...payload.cashRoundings[0] }); }],
        ['cashRoundings[0].paymentId', payload => { payload.cashRoundings[0].paymentId = 'no-such-payment'; }],
        ['cashRoundings[0].minor', payload => { payload.cashRoundings[0].minor = 0; }],
        ['cashRoundings[0].minor', payload => { payload.cashRoundings[0].minor = 1.5; }],
        ['cashRoundings[0].x', payload => { payload.cashRoundings[0].x = 1; }],
      ];
      for (const [message, change] of cases) {
        const command = roundedSale(1003, [cash5(1005)], [{ index: 0, minor: 2 }]);
        change(payloadOf(command));
        await expectRefused(command, 'invalid_payload', message);
      }
    });

    it('row 25: at versions 5 and 7, an unnamed cash leg rounds by the enabled increments', async () => {
      for (const version of [5, 7]) {
        const command = roundedSale(1003, [cash5(1005)], [{ index: 0, minor: 2 }], version);
        expect(payloadOf(command).payments[0].methodId).toBeUndefined();
        await expectApplied(command, 2);
      }
    });

    it('row 26: an unnamed cash leg not a multiple of any enabled increment is refused', async () => {
      await expectRefused(roundedSale(1003, [cash5(1004)], [{ index: 0, minor: 1 }], 5), 'invalid_payload', 'payments[0].amountMinor');
    });
  });

  // ADR-094 P1c: an entry above the void-free maximum (front desk rulings 4 and 5) is applied as P1b stores it, with a
  // cash_rounding_unexplained warning, the same entries in tallySnapshot and one private order note.
  describe('(h) cash_rounding_unexplained (P1c)', () => {
    const snapshotOf = async (orderId: string) => JSON.parse((await connection.rawConnection.getRepository(Order)
      .findOneByOrFail({ id: environment.decode(orderId) })).customFields.tallySnapshot!);
    async function notesOf(orderId: string) {
      const { order } = await adminClient.query<{ order: { history: { items: Array<{ type: string; isPublic: boolean; data: { note?: string } }> } } }>(
        parse('query Notes($id: ID!) { order(id: $id) { history { items { type isPublic data } } } }'), { id: orderId });
      return order.history.items.filter(item => item.type === 'ORDER_NOTE');
    }
    async function expectUnexplained(command: ReturnType<typeof roundedSale>, cashMinor: number,
      expected: Array<{ index: number; minor: number; maxMinor: number }>) {
      const { result } = await expectApplied(command, cashMinor);
      const payments = payloadOf(command).payments as Array<{ clientPaymentId: string }>;
      const entries = expected.map(({ index, minor, maxMinor }) => ({ paymentId: payments[index].clientPaymentId, minor, maxMinor }));
      expect(result.warnings).toEqual(entries.length ? entries.map(entry => ({ code: 'cash_rounding_unexplained', ...entry })) : undefined);
      const orderId = result.serverRefs!.orderId;
      const snapshot = await snapshotOf(orderId);
      const notes = await notesOf(orderId);
      if (!entries.length) {
        expect(snapshot).not.toHaveProperty('cashRoundingUnexplained');
        expect(notes).toEqual([]);
      } else {
        expect(snapshot.cashRoundingUnexplained).toEqual(entries);
        expect(notes).toHaveLength(1);
        expect(notes[0].isPublic).toBe(false);
      }
      return { entries, notes };
    }

    it('W1: an ordinary round up raises nothing', async () => {
      await expectUnexplained(roundedSale(1003, [cash5(1005)], [{ index: 0, minor: 2 }]), 2, []);
    });

    it('W2: a write-off within nearest\'s maximum raises nothing', async () => {
      await expectUnexplained(roundedSale(1002, [card(1000)], [{ index: 0, minor: -2 }]), -2, []);
    });

    it('W3: any write-off under an up-only rounder is unexplained (max 0)', async () => {
      await withMethods({ 'cash-5': false, 'cash-5-up': true }, async () => {
        await expectUnexplained(roundedSale(1002, [card(1000)], [{ index: 0, minor: -2 }]), -2, [{ index: 0, minor: -2, maxMinor: 0 }]);
      });
    });

    it('W4: a half-increment write-off under cash-10 is unexplained (max 4)', async () => {
      await withMethods({ 'cash-5': false, 'cash-10': true }, async () => {
        await expectUnexplained(roundedSale(1005, [card(1000)], [{ index: 0, minor: -5 }]), -5, [{ index: 0, minor: -5, maxMinor: 4 }]);
      });
    });

    it('W5: the #1295 sale warns once, on the card entry only', async () => {
      await expectUnexplained(roundedSale(1008, [card(497), cash5(510)], [{ index: 0, minor: -3 }, { index: 1, minor: 2 }]), -1,
        [{ index: 0, minor: -3, maxMinor: 2 }]);
    });

    it('W6: a pick and a write-off merged on one cash leg raises nothing (max 4)', async () => {
      await expectUnexplained(roundedSale(503, [cash5(500)], [{ index: 0, minor: -3 }]), -3, []);
    });

    it('W7: an entry inside the bound but above the maximum is unexplained', async () => {
      await expectUnexplained(roundedSale(1009, [cash5(1000)], [{ index: 0, minor: -9 }]), -9, [{ index: 0, minor: -9, maxMinor: 4 }]);
    });

    it('W8: a write-off with two rounders enabled takes the larger maximum', async () => {
      await withMethods({ 'cash-10': true }, async () => {
        await expectUnexplained(roundedSale(1003, [card(1000)], [{ index: 0, minor: -3 }]), -3, []);
      });
    });

    it('W9: down mode allows a write-off of inc − 1 and an entry of 2(inc − 1)', async () => {
      await withMethods({ 'cash-5': false, 'cash-5-down': true }, async () => {
        await expectUnexplained(roundedSale(1004, [card(1000)], [{ index: 0, minor: -4 }]), -4, []);
        await expectUnexplained(roundedSale(1008, [cash5down(1000)], [{ index: 0, minor: -8 }]), -8, []);
        await expectUnexplained(roundedSale(1009, [cash5down(1000)], [{ index: 0, minor: -9 }]), -9, [{ index: 0, minor: -9, maxMinor: 8 }]);
      });
    });

    it('W10: an unnamed cash leg takes the largest rounder\'s entry maximum', async () => {
      await expectUnexplained(roundedSale(1004, [cash5(1000)], [{ index: 0, minor: -4 }], 5), -4, []);
      await expectUnexplained(roundedSale(1006, [cash5(1000)], [{ index: 0, minor: -6 }], 5), -6, [{ index: 0, minor: -6, maxMinor: 4 }]);
    });

    it('W11: the warning is stored in tallySnapshot and as one private order note', async () => {
      const command = roundedSale(1008, [card(497), cash5(510)], [{ index: 0, minor: -3 }, { index: 1, minor: 2 }]);
      const { entries, notes } = await expectUnexplained(command, -1, [{ index: 0, minor: -3, maxMinor: 2 }]);
      expect(notes).toEqual([{ type: 'ORDER_NOTE', isPublic: false, data: { note: 'Cash rounding above what a till takes without voiding '
        + `a tender (TallyUI#1364): -3 on payment ${entries[0].paymentId} (at most 2). Check this sale's payments before relying on its total.` } }]);
      expect(notes[0].data.note).toContain('-3');
      expect(notes[0].data.note).toContain('2');
    });

    it('W12: an old till\'s sale without cashRoundings raises nothing', async () => {
      for (const version of [5, 10]) {
        const command = roundedSale(1003, [card(1003)], [], version);
        expect(payloadOf(command).cashRoundings).toBeUndefined();
        await expectUnexplained(command, 0, []);
      }
    });
  });
});
