import { randomUUID } from 'node:crypto';
import type { CommandEnvelope, OrderCreateLine, OrderCreatePayload, OrderCreatePayment } from '../src/vendored/commands';

function id() {
  const uuid = randomUUID();
  return uuid.slice(0, 14) + '7' + uuid.slice(15);
}

type Line = Omit<OrderCreateLine, 'clientLineId'> & { clientLineId?: string };
type Tender = Omit<OrderCreatePayment, 'clientPaymentId'> & { clientPaymentId?: string };

// Undiscounted DK 25% figures, rounded per line, half away from zero.
export function orderCommand(
  inputLines: Line[],
  tenders?: Tender[],
  customer?: OrderCreatePayload['customer'],
): CommandEnvelope<OrderCreatePayload> {
  const lines = inputLines.map(line => ({ clientLineId: id(), ...line }));
  const figures = lines.map(line => {
    const amount = line.unitPriceMinor * line.quantity;
    const denominator = line.taxInclusive ? 125n : 100n;
    const tax = Number((BigInt(amount) * 50n + denominator) / (denominator * 2n));
    const net = line.taxInclusive ? amount - tax : amount;
    return { net, tax, gross: net + tax };
  });
  const subtotalMinor = figures.reduce((sum, line) => sum + line.net, 0);
  const taxMinor = figures.reduce((sum, line) => sum + line.tax, 0);
  const totalMinor = subtotalMinor + taxMinor;
  const createdAt = '2026-09-28T10:00:00.000Z';
  return {
    id: id(), type: 'order.create', version: 3, createdAt, deviceId: 's1-device', attempt: 1,
    payload: {
      clientOrderId: id(), createdAt, currency: 'EUR', pricesIncludeTax: false,
      lines, subtotalMinor, taxMinor, totalMinor, customer,
      payments: (tenders ?? [{ method: 'cash', amountMinor: totalMinor }])
        .map(tender => ({ clientPaymentId: id(), ...tender })),
      registerId: 's1-device', sessionId: id(), cashierRef: 's1-cashier',
      display: {
        currency: 'EUR', exponent: 2, taxInclusive: false,
        subtotalMinor, discountMinor: 0, taxMinor, totalMinor, orderDiscountMinor: 0,
        lines: lines.map((line, index) => ({
          clientLineId: line.clientLineId, amountMinor: figures[index].net, discounts: [],
        })),
      },
      taxByRate: [{ ratePpm: 250000, netMinor: subtotalMinor, taxMinor, grossMinor: totalMinor }],
    },
  };
}
