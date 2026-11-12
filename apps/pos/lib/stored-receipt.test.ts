import { describe, expect, it } from 'vitest';
import type { VendureOrder } from '@tallyui/connector-vendure';
import { storedReceiptData } from './stored-receipt';

type Payment = NonNullable<VendureOrder['payments']>[number];
type Line = { quantity: number; linePrice: number; linePriceWithTax: number; proratedLinePrice: number; proratedLinePriceWithTax: number };

/** A Vendure payment as the plugin stores a till tender: method 'tally-pos', the till's method in metadata.tender. */
function payment(amount: number, overrides: Partial<Payment> = {}): Payment {
  return { id: `p-${amount}`, method: 'tally-pos', amount, state: 'Settled', transactionId: 't', createdAt: '2026-10-01T10:00:00.000Z',
    metadata: { tender: { method: 'cash' } }, refunds: [], ...overrides };
}

/** Only the fields toVendureStoreOrder and storedReceiptData read: one mug line, its order totals and its payments. */
function order({ line, total, totalWithTax, discounts = [], tallyPayments = null, payments = [payment(totalWithTax)] }: {
  line: Line; total: number; totalWithTax: number; discounts?: VendureOrder['discounts'];
  tallyPayments?: string | null; payments?: Payment[];
}): VendureOrder {
  return {
    id: '7', code: 'ORD-7', state: 'PaymentSettled', orderPlacedAt: '2026-10-01T10:00:00.000Z', currencyCode: 'EUR', customer: null,
    customFields: { tallyClientOrderId: 'client-7', tallyPayments },
    lines: [{ id: 'l1', productVariant: { id: '1', name: 'Tally Fixture Mug', sku: 'TALLY-MUG' }, ...line }],
    surcharges: [], shippingLines: [], discounts, total, totalWithTax,
    taxSummary: [{ description: 'Standard DE', taxRate: 19, taxBase: total, taxTotal: totalWithTax - total }],
    payments,
  } as unknown as VendureOrder;
}

// Two mugs at EUR 8.00 net, EUR 9.52 with 19 % tax.
const EXCLUSIVE: Line = { quantity: 2, linePrice: 1600, linePriceWithTax: 1904, proratedLinePrice: 1600, proratedLinePriceWithTax: 1904 };

describe('storedReceiptData', () => {
  it('a tax-inclusive order shows gross lines, the line discount and the order total', () => {
    // 2 × EUR 11.90 gross (EUR 10.00 net) less 10 %: EUR 21.42 gross, EUR 18.00 net.
    const inclusive = order({
      line: { quantity: 2, linePrice: 2000, linePriceWithTax: 2380, proratedLinePrice: 1800, proratedLinePriceWithTax: 2142 },
      total: 1800, totalWithTax: 2142, discounts: [{ description: '10% off', amount: -200, amountWithTax: -238 }],
    });
    const receipt = storedReceiptData(inclusive, { storeName: 'Store', pricesIncludeTax: true });
    expect(receipt.lineItems[0].displayAmountMinor).toBe(2380);
    expect(receipt.lineItems[0].displayDiscounts).toEqual([{ label: 'Discount', amountMinor: 238 }]);
    expect(receipt.totals.taxInclusive).toBe(true);
    expect(receipt.totals.totalMinor).toBe(inclusive.totalWithTax);
  });

  it('a tax-exclusive order shows net lines and adds the tax', () => {
    const exclusive = order({ line: EXCLUSIVE, total: 1600, totalWithTax: 1904 });
    const receipt = storedReceiptData(exclusive, { storeName: 'Store', pricesIncludeTax: false });
    expect(receipt.totals.taxInclusive).toBe(false);
    expect(receipt.lineItems[0].displayAmountMinor).toBe(EXCLUSIVE.linePrice);
    expect(receipt.totals.taxMinor).toBe(304);
    expect(receipt.totals.totalMinor).toBe(exclusive.totalWithTax);
  });

  it('payments come from tallyPayments with the tendered amount and the change', () => {
    // Three mugs (EUR 28.56): EUR 19.04 of it in cash from a EUR 20.00 note, the rest by card.
    const tenders = [
      { clientPaymentId: 'cash', method: 'cash', amountMinor: 1904, tenderedMinor: 2000, changeMinor: 96 },
      { clientPaymentId: 'card', method: 'external', amountMinor: 952, reference: 'auth-1' },
    ];
    const split = order({
      line: { quantity: 3, linePrice: 2400, linePriceWithTax: 2856, proratedLinePrice: 2400, proratedLinePriceWithTax: 2856 },
      total: 2400, totalWithTax: 2856, tallyPayments: JSON.stringify(tenders),
      payments: [payment(1904), payment(952, { metadata: { tender: { method: 'external' } } })],
    });
    const receipt = storedReceiptData(split, { storeName: 'Store', pricesIncludeTax: false });
    expect(receipt.payments).toEqual([{ method: 'cash', amountMinor: 2000 }, { method: 'external', amountMinor: 952, reference: 'auth-1' }]);
    expect(receipt.changeDueMinor).toBe(96);
    expect(receipt.payments.reduce((sum, row) => sum + row.amountMinor, 0) - receipt.changeDueMinor).toBe(receipt.totals.totalMinor);
  });

  it('without tallyPayments a payment is named by its tender method', () => {
    const card = order({ line: EXCLUSIVE, total: 1600, totalWithTax: 1904, tallyPayments: null,
      payments: [payment(1904, { metadata: { tender: { method: 'card' } } }), payment(500, { state: 'Declined' })] });
    const receipt = storedReceiptData(card, { storeName: 'Store', pricesIncludeTax: false });
    expect(receipt.payments).toEqual([{ method: 'card', amountMinor: 1904 }]);
    expect(receipt.changeDueMinor).toBe(0);
  });

  it("unreadable tallyPayments falls back to the store's payments", () => {
    for (const tallyPayments of ['{not json', '[{"method":"cash"}]']) {
      const unreadable = order({ line: EXCLUSIVE, total: 1600, totalWithTax: 1904, tallyPayments, payments: [payment(1904, { metadata: {} })] });
      const receipt = storedReceiptData(unreadable, { storeName: 'Store', pricesIncludeTax: false });
      expect(receipt.payments).toEqual([{ method: 'tally-pos', amountMinor: 1904 }]);
      expect(receipt.changeDueMinor).toBe(0);
    }
  });
});
