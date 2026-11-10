import { Injectable } from '@nestjs/common';
import { Order, Refund, RequestContext, TransactionalConnection } from '@vendure/core';
import { TALLY_DISCOUNT_SKU } from './constants';

/** The plugin's own sales report shape, versioned; it moves into TallyUI once TallyUI has a report contract. */
export type TallySalesReport = {
  version: 1;
  from: string; to: string;            // as given
  timezone: string;                    // as given or 'UTC'
  currencyCode: string;
  registerId: string | null;
  orders: { count: number; salesMinor: number; taxMinor: number; discountsMinor: number };
  refunds: { count: number; totalMinor: number };
  byMethod: Array<{ method: string; salesMinor: number; refundsMinor: number }>;   // sorted by method, ascending
  byDay: Array<{ day: string; orderCount: number; salesMinor: number; refundsMinor: number }>; // 'YYYY-MM-DD' ascending, only days with an order or a refund
};
export type SalesQuery = { from: string; to: string; registerId?: string; timezone: string };

// tallySaleAt is timestamp without time zone holding the Node process's wall time (node-pg writes a Date in local time);
// Refund.createdAt holds the Postgres session's wall time (now()). Both become real instants before any comparison.
const SALE_AT = '(o.customFields.tallySaleAt AT TIME ZONE :writerZone)';
const REFUND_AT = "(refund.createdAt AT TIME ZONE current_setting('TimeZone'))";
const dayKey = (instant: string) => `to_char(${instant} AT TIME ZONE :timezone, 'YYYY-MM-DD')`;
const SALE_METHOD = "COALESCE(CAST(p.metadata AS jsonb) -> 'tender' ->> 'method', p.method)";
const REFUND_METHOD = "COALESCE(CAST(refund.metadata AS jsonb) ->> 'tallyMethod', CAST(payment.metadata AS jsonb) -> 'tender' ->> 'method', payment.method)";
// SUM and COUNT come back from Postgres as strings (bigint/numeric); money stays integer minor units.
const minor = (value: string | null | undefined) => Number(value ?? 0);

/** GET /tally/v1/reports/sales: the channel's POS sales and refunds in a range, every figure a SQL aggregate. */
@Injectable()
export class ReportService {
  // The zone node-pg wrote tallySaleAt in, read once.
  private readonly writerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  constructor(private connection: TransactionalConnection) {}

  async sales(ctx: RequestContext, query: SalesQuery): Promise<TallySalesReport> {
    const params = { timezone: query.timezone };
    const days = await this.posOrders(ctx, query)
      .select(dayKey(SALE_AT), 'day')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(o.subTotalWithTax + o.shippingWithTax)', 'sales')
      .addSelect('SUM(o.subTotalWithTax - o.subTotal + o.shippingWithTax - o.shipping)', 'tax')
      .setParameters(params).groupBy(dayKey(SALE_AT))
      .getRawMany<{ day: string; count: string; sales: string | null; tax: string | null }>();
    const [discounts] = await this.posOrders(ctx, query)
      .innerJoin('o.surcharges', 's')
      .andWhere('s.sku = :discountSku', { discountSku: TALLY_DISCOUNT_SKU })
      .select('SUM(0 - s.listPrice)', 'discounts')
      .getRawMany<{ discounts: string | null }>();
    const methods = await this.posOrders(ctx, query)
      .innerJoin('o.payments', 'p')
      .andWhere("p.state = 'Settled'")
      .select(SALE_METHOD, 'method')
      .addSelect('SUM(p.amount)', 'sales')
      .groupBy(SALE_METHOD)
      .getRawMany<{ method: string; sales: string | null }>();
    const refunds = await this.posRefunds(ctx, query)
      .select(dayKey(REFUND_AT), 'day')
      .addSelect(REFUND_METHOD, 'method')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(refund.total)', 'total')
      .setParameters(params).groupBy(dayKey(REFUND_AT)).addGroupBy(REFUND_METHOD)
      .getRawMany<{ day: string; method: string; count: string; total: string | null }>();

    const byDay = new Map<string, TallySalesReport['byDay'][number]>();
    const dayOf = (day: string) => byDay.get(day) ?? byDay.set(day, { day, orderCount: 0, salesMinor: 0, refundsMinor: 0 }).get(day)!;
    const byMethod = new Map<string, TallySalesReport['byMethod'][number]>();
    const methodOf = (method: string) => byMethod.get(method) ?? byMethod.set(method, { method, salesMinor: 0, refundsMinor: 0 }).get(method)!;
    const orders = { count: 0, salesMinor: 0, taxMinor: 0, discountsMinor: minor(discounts?.discounts) };
    for (const row of days) {
      const entry = dayOf(row.day);
      entry.orderCount += minor(row.count);
      entry.salesMinor += minor(row.sales);
      orders.count += minor(row.count);
      orders.salesMinor += minor(row.sales);
      orders.taxMinor += minor(row.tax);
    }
    for (const row of methods) methodOf(row.method).salesMinor += minor(row.sales);
    const refundTotals = { count: 0, totalMinor: 0 };
    for (const row of refunds) {
      dayOf(row.day).refundsMinor += minor(row.total);
      methodOf(row.method).refundsMinor += minor(row.total);
      refundTotals.count += minor(row.count);
      refundTotals.totalMinor += minor(row.total);
    }
    // Code-unit order, so the answer never depends on the server's locale.
    const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      version: 1, from: query.from, to: query.to, timezone: query.timezone, currencyCode: ctx.channel.defaultCurrencyCode,
      registerId: query.registerId ?? null, orders, refunds: refundTotals,
      byMethod: [...byMethod.values()].sort((a, b) => ascending(a.method, b.method)),
      byDay: [...byDay.values()].sort((a, b) => ascending(a.day, b.day)),
    };
  }

  /** POS sales: order.create recorded them in full (tallyPayments is written last), not rejected (ADR-068 d13.6), in the channel's currency. */
  private posOrders(ctx: RequestContext, query: SalesQuery) {
    const builder = this.connection.getRepository(ctx, Order).createQueryBuilder('o')
      .innerJoin('o.channels', 'channel')
      .where('channel.id = :channelId', { channelId: ctx.channelId })
      .andWhere('o.customFields.tallyClientOrderId IS NOT NULL')
      .andWhere('o.customFields.tallyPayments IS NOT NULL')
      .andWhere('o.customFields.tallyRejected IS NOT TRUE')
      .andWhere('o.currencyCode = :currency', { currency: ctx.channel.defaultCurrencyCode })
      .andWhere(`${SALE_AT} >= CAST(:from AS timestamptz)`, { writerZone: this.writerZone, from: query.from })
      .andWhere(`${SALE_AT} < CAST(:to AS timestamptz)`, { to: query.to });
    return query.registerId === undefined ? builder
      : builder.andWhere('o.customFields.tallyRegisterId = :registerId', { registerId: query.registerId });
  }

  /** Non-failed refunds of the channel's POS orders, on the date each was made (which may be outside the sale's range). */
  private posRefunds(ctx: RequestContext, query: SalesQuery) {
    const builder = this.connection.getRepository(ctx, Refund).createQueryBuilder('refund')
      .innerJoin('refund.payment', 'payment')
      .innerJoin('payment.order', 'sale')
      .innerJoin('sale.channels', 'channel')
      .where('channel.id = :channelId', { channelId: ctx.channelId })
      .andWhere('refund.state != :failed', { failed: 'Failed' })
      .andWhere('sale.customFields.tallyClientOrderId IS NOT NULL')
      .andWhere('sale.currencyCode = :currency', { currency: ctx.channel.defaultCurrencyCode })
      .andWhere(`${REFUND_AT} >= CAST(:from AS timestamptz)`, { from: query.from })
      .andWhere(`${REFUND_AT} < CAST(:to AS timestamptz)`, { to: query.to });
    // A dashboard refund carries no register id, so it counts under its sale's register.
    return query.registerId === undefined ? builder : builder.andWhere(
      "COALESCE(CAST(refund.metadata AS jsonb) ->> 'tallyRegisterId', sale.customFields.tallyRegisterId) = :registerId",
      { registerId: query.registerId });
  }
}
