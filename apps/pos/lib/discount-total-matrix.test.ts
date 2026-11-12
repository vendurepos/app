import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVendureConnector } from '@tallyui/connector-vendure';
import type { OrderCreateEnvelope, StoreSettings } from '@tallyui/core';
import {
  addEntryToCart, addPosOrderCollection, catalogueEntries, createOrderBuilder, finalizeOrder,
  posOrderSchema, TaxProvider, taxProviderProps, toOrderCreateEnvelope, useTax,
  type PosOrder, type TaxContext, type TaxProviderProps,
} from '@tallyui/pos';
import { createElement } from 'react';
// @ts-expect-error The app has react-dom (for the web build) but not @types/react-dom.
import { renderToString } from 'react-dom/server';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fiscalFiguresErrors } from '../../../packages/vendure-plugin/src/vendored/fiscal-figures';
import { MICROS_PER_MINOR, roundMicrosToMinor, taxMicros } from '../../../packages/vendure-plugin/src/vendored/tax-exact';

const packageRequire = createRequire(import.meta.url);
const tallyuiVersion: string = packageRequire(join(dirname(packageRequire.resolve('@tallyui/pos')), '../package.json')).version;
const envelopePath = fileURLToPath(new URL('../../../packages/vendure-plugin/test/fixtures/discount-matrix.json', import.meta.url));
const frozenPath = fileURLToPath(new URL('./__fixtures__/pos-orders-tallyui-3.19.0.json', import.meta.url));
const now = new Date('2026-11-12T10:00:00.000Z');
const matrix = (['per_line_items', 'per_rate_group_items'] as const).flatMap((granularity) =>
  (['exclusive', 'inclusive'] as const).flatMap((mode) =>
    (['plain', 'line', 'order', 'line+order'] as const).map((cell) => ({
      granularity, mode, cell, key: `${granularity}/${mode}/${cell}`,
    }))));

const variant = (id: string, sku: string, price: number, priceWithTax: number, category: string, name = sku) =>
  ({ id, name, sku, price, priceWithTax, currencyCode: 'EUR', enabled: true, trackInventory: 'FALSE', taxCategory: { id: category } });
const products = [
  { id: 'standard', name: 'Standard', variants: [variant('VARIANT_STANDARD', 'STANDARD', 1000, 1190, '1')] },
  { id: 'reduced', name: 'Reduced', variants: [variant('VARIANT_REDUCED', 'REDUCED', 500, 535, '2')] },
];

/** The same tax context the till's TaxProvider gives a sale. */
function saleTaxContext(settings: StoreSettings): TaxContext {
  let context: TaxContext | undefined;
  const Probe = () => { context = useTax(); return null; };
  renderToString(createElement(TaxProvider, taxProviderProps(settings) as TaxProviderProps, createElement(Probe)));
  return context!;
}

type StoredCell = { doc: PosOrder; envelope: OrderCreateEnvelope };
type FrozenOrders = { tallyuiVersion: string; schemaVersion: number; cells: Record<string, StoredCell> };
const built: Record<string, StoredCell & { totalMinor: number }> = {};
const jsonEntries = (entries: [string, unknown][], indent: string) =>
  entries.map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n');

describe('the till discount totals and frozen 3.19.0 orders', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const db = await createRxDatabase({
      name: 'discount_matrix_build', multiInstance: false,
      storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
    });
    try {
      const orders = await addPosOrderCollection(db);
      let nextId = 0;
      const newId = () => `019a793a-2100-7000-8000-${(++nextId).toString(16).padStart(12, '0')}`;
      // A fixed build order also freezes the builder's Date.now()/counter discount ids.
      for (const { granularity, mode, cell, key } of matrix) {
        const pricesIncludeTax = mode === 'inclusive';
        const settings: StoreSettings = {
          currency: 'EUR', pricesIncludeTax,
          taxRatesPpm: { default: 190_000, '1': 190_000, '2': 70_000 },
          taxRateCodes: { default: 'Standard DE', '1': 'Standard DE', '2': 'Reduced DE' },
          taxRounding: { granularity, mode: 'half_up' },
        };
        const traits = createVendureConnector({ pricesIncludeTax }).traits.product;
        const entries = catalogueEntries(products, traits);
        const builder = createOrderBuilder({ currency: 'EUR', taxContext: saleTaxContext(settings) });
        const standard = addEntryToCart(builder, entries[0], traits, 'EUR');
        addEntryToCart(builder, entries[1], traits, 'EUR');
        addEntryToCart(builder, entries[1], traits, 'EUR');
        expect(builder.getSnapshot().lineItems.map(({ unitPriceMinor, quantity }) => [unitPriceMinor, quantity]), key)
          .toEqual(pricesIncludeTax ? [[1190, 1], [535, 2]] : [[1000, 1], [500, 2]]);
        if (cell === 'line' || cell === 'line+order') builder.applyLineDiscount(standard, { type: 'percentage', value: 10 });
        if (cell === 'order' || cell === 'line+order') builder.applyOrderDiscount({ type: 'fixed', value: 333 });
        const totalMinor = builder.getSnapshot().totalMinor;
        if (cell === 'line+order') {
          builder.addPayment({ method: 'cash', amountMinor: 1000 });
          builder.addPayment({ method: 'external', amountMinor: totalMinor - 1000 });
        } else {
          builder.addPayment({ method: 'cash', amountMinor: totalMinor });
        }
        const finalized = finalizeOrder(builder.getSnapshot(), {
          now, newId, registerId: 'register-1', cashierRef: 'cashier@example.com',
          capabilities: { orderCreate: 5, register: 2 },
        });
        await orders.insert(finalized);
        const doc = (await orders.findOne(finalized.id).exec())!.toMutableJSON();
        built[key] = { doc, envelope: toOrderCreateEnvelope(doc, 'device_matrix', 1, { maxVersion: 5 }), totalMinor };
      }
    } finally {
      vi.useRealTimers();
      await db.close();
    }
  });

  it.each(matrix)('$key reconciles the sent figures to the charged amount', ({ key }) => {
    const { doc, envelope, totalMinor } = built[key];
    const { payload } = envelope;
    expect(envelope.version, key).toBeLessThanOrEqual(5);
    expect(payload, key).not.toHaveProperty('coupons');
    expect(payload.totalMinor, key).toBe(payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0));
    expect(payload.totalMinor, key).toBe(totalMinor);
    expect(payload.totalMinor, key).toBe(payload.subtotalMinor + payload.taxMinor);
    expect(fiscalFiguresErrors(payload), key).toEqual([]);
    // The wire contract omits discountMinor when it is zero, on both orders and lines.
    const discountMinor = payload.discountMinor ?? 0;
    expect(discountMinor, key).toBe(payload.lines.reduce((sum, line) => sum + (line.discountMinor ?? 0), 0));
    let undiscountedNet = 0;
    for (const [index, line] of doc.lines.entries()) {
      const amount = line.unitPriceMinor * line.quantity;
      const discount = line.discountMinor;
      const ratePpm = line.taxLines.reduce((sum, tax) => sum + tax.ratePpm, 0);
      const inclusive = line.taxInclusive ?? doc.pricesIncludeTax;
      // Independent #786 oracle: derive both nets from A and D, never stored taxMicros.
      const netBefore = BigInt(amount) * MICROS_PER_MINOR - taxMicros(amount, ratePpm, true);
      const netAfter = BigInt(amount - discount) * MICROS_PER_MINOR - taxMicros(amount - discount, ratePpm, true);
      const expectedDiscount = inclusive ? roundMicrosToMinor(netBefore - netAfter) : discount;
      expect(payload.lines[index].discountMinor ?? 0, `${key}/${line.variantId}: A=${amount}, D=${discount}, ratePpm=${ratePpm}`)
        .toBe(expectedDiscount);
      undiscountedNet += inclusive ? roundMicrosToMinor(netBefore) : amount;
    }
    expect(Math.abs(undiscountedNet - discountMinor - payload.subtotalMinor), `${key}: net before discount=${undiscountedNet}`)
      .toBeLessThanOrEqual(Math.ceil(payload.lines.length / 2));
  });

  it('snapshots the envelopes and proves stored 3.19.0 orders reopen and resend unchanged', async () => {
    const envelopes = matrix.map(({ key }): [string, OrderCreateEnvelope] => [key, built[key].envelope]);
    await expect(`{\n${jsonEntries(envelopes, '  ')}\n}\n`).toMatchFileSnapshot(envelopePath);
    if (tallyuiVersion === '3.19.0') {
      const cells = matrix.map(({ key }): [string, StoredCell] => [key, { doc: built[key].doc, envelope: built[key].envelope }]);
      const text = `{\n  "tallyuiVersion": "3.19.0",\n  "schemaVersion": ${posOrderSchema.version},\n  "cells": {\n${jsonEntries(cells, '    ')}\n  }\n}\n`;
      await expect(text).toMatchFileSnapshot(frozenPath);
    }
    // File snapshots are normally flushed after the suite; U1/U2 must read the first -u run's file too.
    await expect.getState().snapshotState.save();
    const frozen: FrozenOrders = JSON.parse(await readFile(frozenPath, 'utf8'));
    expect(frozen.tallyuiVersion).toBe('3.19.0');
    expect(Object.keys(frozen.cells)).toEqual(matrix.map(({ key }) => key));
    // U1: a schema bump must replace this with a migration test that opens the old
    // documents through the new collection's migration strategies.
    expect(frozen.schemaVersion).toBe(posOrderSchema.version);
    const db = await createRxDatabase({
      name: 'discount_matrix_reopen', multiInstance: false,
      storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
    });
    try {
      const orders = await addPosOrderCollection(db);
      for (const { key } of matrix) {
        const { doc, envelope } = frozen.cells[key];
        // U2: validate the old document against the current schema and resend it.
        await orders.insert(doc);
        const readBack = (await orders.findOne(doc.id).exec())!.toMutableJSON();
        expect(toOrderCreateEnvelope(readBack, 'device_matrix', 1, { maxVersion: 5 }), `${key}: stored resend`).toEqual(envelope);
        // U3: a freshly built sale must still send the frozen 3.19.0 envelope.
        expect(built[key].envelope, `${key}: fresh envelope`).toEqual(envelope);
      }
    } finally {
      await db.close();
    }
  });

  it('requires a coupon cell before the till applies coupons', async () => {
    for (const directory of ['../app', '.']) {
      const root = fileURLToPath(new URL(directory, import.meta.url));
      for (const file of await readdir(root, { recursive: true })) {
        if (!/\.tsx?$/.test(file) || /\.(test|spec)\.tsx?$/.test(file) || file.split('/').includes('__tests__')) continue;
        const source = await readFile(join(root, file), 'utf8');
        expect(source, `${directory}/${file}: this matrix needs a coupon cell before the till applies coupons`)
          .not.toMatch(/setCoupons\(|couponContext/);
      }
    }
  });
});
