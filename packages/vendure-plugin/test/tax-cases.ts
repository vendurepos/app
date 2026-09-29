import { Order, TransactionalConnection } from '@vendure/core';
import { parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderCreateResult } from '../src';
import { roundHalfAwayFromZero } from '../src/service/rounding';
import { fiscalFiguresErrors } from '../src/vendored/fiscal-figures';
import { payloadShapeErrors } from '../src/vendored/payload-shape';
import { MICROS_PER_MINOR, ratePpmFromPercent, roundMicrosToMinor, taxMicros } from '../src/vendored/tax-exact';
import { createPluginTestEnvironment } from './env';
import { orderCommand } from './payloads';

export function taxCases(strategy: string, override: Parameters<typeof createPluginTestEnvironment>[0] = {}) {
  describe(`proof 1 tax parity: ${strategy}`, () => {
    const environment = createPluginTestEnvironment(override);
    const { server, adminClient, variantIds, decode, run } = environment;
    let connection: TransactionalConnection;
    let channelId: string;
    let germanyId: string;
    beforeAll(async () => {
      await environment.init();
      connection = server.app.get(TransactionalConnection);
      const setup = await adminClient.query<{
        activeChannel: { id: string }; zones: { items: Array<{ id: string; name: string }> };
      }>(parse('query { activeChannel { id } zones { items { id name } } }'));
      channelId = setup.activeChannel.id;
      germanyId = setup.zones.items.find(zone => zone.name === 'Germany')!.id;
    });
    afterAll(() => server.destroy());

    // Update the existing channel between cases; Germany is both default zones.
    async function setMode(pricesIncludeTax: boolean) {
      const updated = await adminClient.query<{ updateChannel: { pricesIncludeTax: boolean } }>(parse(`
        mutation Mode($input: UpdateChannelInput!) {
          updateChannel(input: $input) { ... on Channel { pricesIncludeTax } }
        }
      `), { input: { id: channelId, pricesIncludeTax, defaultTaxZoneId: germanyId, defaultShippingZoneId: germanyId } });
      expect(updated.updateChannel.pricesIncludeTax).toBe(pricesIncludeTax);
    }

    async function submit(command: ReturnType<typeof orderCommand>) {
      expect(payloadShapeErrors(command.payload)).toEqual([]);
      if (command.version === 3) expect(fiscalFiguresErrors(command.payload)).toEqual([]);
      const result = await run(command);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
      const order = await connection.rawConnection.getRepository(Order).findOneOrFail({
        where: { id: decode(result.serverRefs!.orderId) }, relations: ['lines', 'surcharges', 'shippingLines', 'fulfillments'],
      });
      return { order, result };
    }

    // The bound on the rounding bridge: B = ceil((lines + surcharges) / 2) from the saved order;
    // a missing total_mismatch warning means bridgeMinor = 0.
    function bridgeBound(order: Order, result: OrderCreateResult) {
      const B = Math.ceil((order.lines.length + order.surcharges.length) / 2);
      const warning = result.totalWarnings?.find(item => item.code === 'total_mismatch');
      const bridge = warning?.code === 'total_mismatch' ? warning.bridgeMinor : 0;
      return { B, bridge };
    }

    for (const pricesIncludeTax of [false, true]) {
      const mode = pricesIncludeTax ? 'inclusive' : 'exclusive';
      for (const caseName of ['a-discount', 'b-mixed', 'c-negative-tie']) {
        it(`${mode}: ${caseName}, Delivered with total and per-rate parity, bridge within bound`, async () => {
          await setMode(pricesIncludeTax);
          const lines = caseName === 'c-negative-tie' ? [
            // An exclusive discount of -50 at 19% owes -9.5 minor tax, also in an inclusive channel.
            { variantId: variantIds.mug[0], unitPriceMinor: 101, quantity: 1, discountMinor: 50,
              taxInclusive: false, ratePpm: 190000 },
          ] : [
            { variantId: variantIds.mug[0], unitPriceMinor: 101, quantity: 1, ratePpm: 190000,
              ...(caseName === 'b-mixed' ? { taxInclusive: !pricesIncludeTax } : {}) },
            { variantId: variantIds.beans[0], unitPriceMinor: 102, quantity: 1, ratePpm: 70000 },
            { variantId: variantIds.beans[1], unitPriceMinor: 103,
              quantity: caseName === 'a-discount' ? 3 : 1, discountMinor: 17, ratePpm: 70000 },
          ];
          const command = orderCommand(lines, undefined, undefined, { pricesIncludeTax });
          if (caseName === 'c-negative-tie') {
            const negativeTax = taxMicros(-50, 190000, false);
            expect(negativeTax % MICROS_PER_MINOR).toBe(-500000n);
            expect(roundMicrosToMinor(negativeTax)).toBe(-10);
            expect(roundHalfAwayFromZero(negativeTax, MICROS_PER_MINOR)).toBe(-10n);
          } else {
            expect(command.payload.taxByRate!.map(rate => rate.ratePpm).sort()).toEqual([190000, 70000].sort());
          }
          const { order, result } = await submit(command);
          const serverRates = new Map<number, number>();
          for (const row of order.taxSummary) {
            const rate = ratePpmFromPercent(row.taxRate);
            serverRates.set(rate, (serverRates.get(rate) ?? 0) + row.taxTotal);
          }
          const posRates = new Map(command.payload.taxByRate!.map(rate => [rate.ratePpm, rate.taxMinor]));
          const perRate = [...new Set([...posRates.keys(), ...serverRates.keys()])].map(ratePpm => ({
            ratePpm, diff: (serverRates.get(ratePpm) ?? 0) - (posRates.get(ratePpm) ?? 0),
          }));
          const T = Math.ceil((order.lines.length + order.surcharges.length) / 2);
          const bridges = order.surcharges.filter(row => row.sku === 'TALLY-ROUNDING');
          const bridge = bridges.reduce((sum, row) => sum + row.listPrice, 0);
          const bound = bridgeBound(order, result);
          expect(bound.bridge).toBe(bridge);
          expect(Math.abs(bound.bridge), JSON.stringify(bound)).toBeLessThanOrEqual(bound.B);
          expect(order.totalWithTax).toBe(command.payload.totalMinor);
          expect(result.serverRefs!.totalMinor).toBe(command.payload.totalMinor);
          expect(order.state).toBe('Delivered');
          expect(order.fulfillments.map(item => item.state)).toEqual(['Delivered']);
          for (const rate of perRate) expect(Math.abs(rate.diff), JSON.stringify(rate)).toBeLessThanOrEqual(T);
          expect(result.totalWarnings?.filter(warning => warning.code === 'tax_rate_mismatch') ?? []).toEqual([]);
          expect(bridges).toHaveLength(bridge === 0 ? 0 : 1);
          expect(result.totalWarnings?.filter(warning => warning.code === 'total_mismatch') ?? []).toEqual(
            bridge === 0 ? [] : [{ code: 'total_mismatch', expectedMinor: command.payload.totalMinor,
              serverMinor: command.payload.totalMinor - bridge, bridgeMinor: bridge }],
          );
          if (bridge !== 0) expect(bridges[0]).toMatchObject({
            description: 'POS rounding', listPriceIncludesTax: true, taxLines: [],
          });
          const discounts = order.surcharges.filter(row => row.sku === 'TALLY-DISCOUNT');
          expect(discounts).toHaveLength(1);
          const discounted = command.payload.lines.find(line => line.discountMinor)!;
          const savedLine = order.lines.find(line => line.customFields.tallyClientLineId === discounted.clientLineId)!;
          expect(discounts[0]).toMatchObject({
            description: 'POS discount', listPrice: -discounted.discountMinor!,
            listPriceIncludesTax: discounted.taxInclusive ?? pricesIncludeTax, taxLines: savedLine.taxLines,
          });
        });
      }
    }

    it('v2 applies the same own-mode discount without a v3 snapshot, bridge within bound', async () => {
      await setMode(false);
      const command = orderCommand([
        { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 101, discountMinor: 50, ratePpm: 190000 },
      ], undefined, undefined, { version: 2 });
      const { order, result } = await submit(command);
      const bound = bridgeBound(order, result);
      expect(Math.abs(bound.bridge), JSON.stringify(bound)).toBeLessThanOrEqual(bound.B);
      expect(order.state).toBe('Delivered');
      expect(order.totalWithTax).toBe(command.payload.totalMinor);
      expect(order.surcharges.find(row => row.sku === 'TALLY-DISCOUNT')?.listPrice).toBe(-50);
      expect(order.customFields.tallySnapshot).toBeNull();
    });

    it('negative control: a POS total off by B + 5 is applied, bridged in full, and exceeds the bound', async () => {
      await setMode(false);
      // 100 net at 19% is 119 in both POS and Vendure, so the only bridge is the offset.
      // One line plus the bridge surcharge gives B = ceil(2 / 2) = 1.
      const expectedB = 1;
      const offset = expectedB + 5;
      const command = orderCommand([{ variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 100, ratePpm: 190000 }]);
      expect(command.payload.totalMinor).toBe(119);
      command.payload.totalMinor += offset;
      command.payload.subtotalMinor += offset;
      command.payload.display!.totalMinor += offset;
      command.payload.display!.subtotalMinor += offset;
      command.payload.display!.lines[0].amountMinor += offset;
      command.payload.payments[0].amountMinor += offset;
      const { order, result } = await submit(command);
      const bound = bridgeBound(order, result);
      expect(order.state).toBe('Delivered');
      expect(order.totalWithTax).toBe(command.payload.totalMinor);
      expect(bound.B).toBe(expectedB);
      expect(bound.bridge).toBe(offset);
      expect(result.totalWarnings).toEqual([{ code: 'total_mismatch', expectedMinor: 119 + offset, serverMinor: 119, bridgeMinor: offset }]);
      // The parity cases' bound assertion would catch this bridge.
      expect(Math.abs(bound.bridge)).toBeGreaterThan(bound.B);
      expect(() => expect(Math.abs(bound.bridge)).toBeLessThanOrEqual(bound.B)).toThrow();
    });

    it('reports an above-bound v3 per-rate discrepancy without refusing the sale', async () => {
      await setMode(false);
      const command = orderCommand([
        { variantId: variantIds.mug[0], quantity: 1, unitPriceMinor: 100, ratePpm: 190000 },
        { variantId: variantIds.beans[0], quantity: 1, unitPriceMinor: 100, ratePpm: 70000 },
      ]);
      // Deliberately wrong rate allocation, but unchanged total tax and settlement.
      command.payload.taxByRate![0].taxMinor += 5;
      command.payload.taxByRate![0].grossMinor += 5;
      command.payload.taxByRate![1].taxMinor -= 5;
      command.payload.taxByRate![1].grossMinor -= 5;
      const { order, result } = await submit(command);
      expect(order.state).toBe('Delivered');
      expect(order.totalWithTax).toBe(command.payload.totalMinor);
      expect(result.totalWarnings).toEqual([
        { code: 'tax_rate_mismatch', ratePpm: 190000, expectedMinor: 24, serverMinor: 19 },
        { code: 'tax_rate_mismatch', ratePpm: 70000, expectedMinor: 2, serverMinor: 7 },
      ]);
    });
  });
}
