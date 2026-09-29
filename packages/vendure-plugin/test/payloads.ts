import { randomUUID } from 'node:crypto';
import type { CommandEnvelope, OrderCreateLine, OrderCreatePayload, OrderCreatePayment } from '../src/vendored/commands';
import { roundMicrosToMinor, taxLinesByRate, taxMicros } from '../src/vendored/tax-exact';

function id() {
  const uuid = randomUUID();
  return uuid.slice(0, 14) + '7' + uuid.slice(15);
}

type Line = Omit<OrderCreateLine, 'clientLineId'> & { clientLineId?: string; ratePpm?: number };
type Tender = Omit<OrderCreatePayment, 'clientPaymentId'> & { clientPaymentId?: string };

// ADR-037/062: tax the discounted line amount in its own mode, then round once.
// Default DK 25% keeps the original callers working; tax proofs supply DE rates.
export function orderCommand(
  inputLines: Line[],
  tenders?: Tender[],
  customer?: OrderCreatePayload['customer'],
  options: { pricesIncludeTax?: boolean; version?: 2 | 3 } = {},
): CommandEnvelope<OrderCreatePayload> {
  const pricesIncludeTax = options.pricesIncludeTax ?? false;
  const lines = inputLines.map(({ ratePpm, ...line }) => ({ clientLineId: id(), ...line }));
  const figures = lines.map((line, index) => {
    const amount = line.unitPriceMinor * line.quantity;
    const discount = line.discountMinor ?? 0;
    const netMinor = amount - discount;
    const taxInclusive = line.taxInclusive ?? pricesIncludeTax;
    const ratePpm = inputLines[index].ratePpm ?? 250000;
    const micros = taxMicros(netMinor, ratePpm, taxInclusive);
    const displayAmount = (value: number) => {
      if (taxInclusive === pricesIncludeTax) return value;
      const tax = roundMicrosToMinor(taxMicros(value, ratePpm, taxInclusive));
      return taxInclusive ? value - tax : value + tax;
    };
    return {
      netMinor, taxInclusive, micros, taxLines: [{ ratePpm, taxMicros: String(micros) }],
      remaining: displayAmount(netMinor), discount: displayAmount(discount),
      amount: taxInclusive === pricesIncludeTax ? amount : displayAmount(netMinor) + displayAmount(discount),
    };
  });
  const taxMinor = roundMicrosToMinor(figures.reduce((sum, line) => sum + line.micros, 0n));
  const totalMinor = figures.reduce((sum, line) => sum + line.netMinor, 0)
    + roundMicrosToMinor(figures.reduce((sum, line) => sum + (line.taxInclusive ? 0n : line.micros), 0n));
  const subtotalMinor = totalMinor - taxMinor;
  const discountMinor = lines.reduce((sum, line) => sum + (line.discountMinor ?? 0), 0);
  const displayDiscount = figures.reduce((sum, line) => sum + line.discount, 0);
  const displaySubtotal = (pricesIncludeTax ? totalMinor : subtotalMinor) + displayDiscount;
  // TallyUI ADR-063: put display conversion residue on converted lines, largest remaining first.
  let residue = displaySubtotal - figures.reduce((sum, line) => sum + line.amount, 0);
  for (const line of figures.filter(line => line.taxInclusive !== pricesIncludeTax)
    .sort((a, b) => b.remaining - a.remaining)) {
    const take = residue > 0 ? residue : Math.max(residue, -line.remaining);
    line.amount += take;
    residue -= take;
  }
  const createdAt = '2026-09-28T10:00:00.000Z';
  return {
    id: id(), type: 'order.create', version: options.version ?? 3, createdAt, deviceId: 'vp1-device', attempt: 1,
    payload: {
      clientOrderId: id(), createdAt, currency: 'EUR', pricesIncludeTax,
      lines, subtotalMinor, taxMinor, totalMinor, customer, ...(discountMinor > 0 ? { discountMinor } : {}),
      payments: (tenders ?? [{ method: 'cash', amountMinor: totalMinor }])
        .map(tender => ({ clientPaymentId: id(), ...tender })),
      registerId: 'vp1-device', cashierRef: 'vp1-cashier',
      ...(options.version === 2 ? {} : { sessionId: id(),
      display: {
        currency: 'EUR', exponent: 2, taxInclusive: pricesIncludeTax,
        subtotalMinor: displaySubtotal, discountMinor: displayDiscount, taxMinor, totalMinor, orderDiscountMinor: 0,
        lines: lines.map((line, index) => ({
          clientLineId: line.clientLineId, amountMinor: figures[index].amount,
          discounts: line.discountMinor ? [{ discountId: 'vp1-fixed', amountMinor: figures[index].discount }] : [],
        })),
      },
      taxByRate: taxLinesByRate(figures, taxMinor).map(({ ratePpm, netMinor, amountMinor }) => ({
        ratePpm, netMinor, taxMinor: amountMinor, grossMinor: netMinor + amountMinor,
      })),
      }),
    },
  };
}
