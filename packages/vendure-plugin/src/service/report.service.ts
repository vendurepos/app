import { Injectable } from '@nestjs/common';
import { Collection, Order, OrderLine, ProductVariant, RequestContext, ShippingLine, Surcharge, TransactionalConnection, translateEntity } from '@vendure/core';
import type { ID } from '@vendure/core';
import { In } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { channelRefunds } from './channel-refunds';
import { TALLY_DISCOUNT_SKU } from './constants';
import { OrderCreateService } from './order-create.service';

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

/** GET /tally/v1/reports/sales/v2: v1's fields plus the figures TallyUI's SalesFigures needs. Every figure is integer minor units. */
export type TallySalesReportV2 = Omit<TallySalesReport, 'version' | 'orders' | 'refunds' | 'byMethod'> & {
  version: 2;
  cashierId: string | null;
  orders: TallySalesReport['orders'] & { itemCount: number };       // itemCount: the sum of order-line quantities
  refunds: TallySalesReport['refunds'] & { orderCount: number };   // orderCount: distinct sale orders refunded in the range
  // orderCount: distinct orders with a settled payment of the method; refundCount: refunds by the method. Sorted by method.
  byMethod: Array<TallySalesReport['byMethod'][number] & { orderCount: number; refundCount: number }>;
  byHour: Array<{ hour: string; orderCount: number; salesMinor: number; refundsMinor: number }>; // 'YYYY-MM-DDTHH' ascending, only active hours
  // Lines sold, by variant: the line total with tax, before the till's order discount (a TALLY_DISCOUNT_SKU surcharge,
  // in orders.discountsMinor). Refunded quantities are not netted. salesMinor descending, then sku; at most 100 rows.
  products: Array<{ productVariantId: string; sku: string; name: string; quantity: number; salesMinor: number }>;
  productsTruncated: boolean;
  // Vendure's own Order.taxSummary (lines, shipping and surcharges), summed by (description, rate); by rate, then description.
  taxes: Array<{ description: string; ratePercent: number; baseMinor: number; taxMinor: number }>;
};
export type SalesQueryV2 = SalesQuery & { cashierId?: string };

/** GET /tally/v1/reports/sales/v3: v2's figures plus the median and largest order and sales by collection. */
export type TallySalesReportV3 = Omit<TallySalesReportV2, 'version' | 'orders'> & {
  version: 3;
  // Over the same per-order totals orders.salesMinor sums (subTotalWithTax + shippingWithTax). medianMinor: the middle
  // total, the mean of the two middles for an even count, rounded half up; 0 with no orders. largestMinor: null with none.
  orders: TallySalesReportV2['orders'] & { medianMinor: number; largestMinor: number | null };
  // Products' line basis, added to every collection of the variant in the channel (a variant in several counts in each,
  // one in none in none). salesMinor descending, then name.
  categories: Array<{ collectionId: string; name: string; quantity: number; salesMinor: number }>;
};
const hourKey = (instant: string) => `to_char(${instant} AT TIME ZONE :timezone, 'YYYY-MM-DD"T"HH24')`;
const MAX_PRODUCTS = 100;
// Orders are loaded for products and taxes (OrderLine prices and Order.taxSummary are getters, not columns) this many at a time.
const ORDER_PAGE = 500;
// Measured on the year fixture: four raw reads can load larger pages without the joined cartesian product.
const RAW_PAGE = 5000;
// Vendure 3.7.3: the drift test reads these copied keys through the guarded entity instances.
const RAW_KEYS = {
  Order: ['id', 'subTotalWithTax', 'shippingWithTax'],
  OrderLine: ['productVariantId', 'quantity', 'orderPlacedQuantity', 'listPrice', 'listPriceIncludesTax', 'adjustments', 'taxLines'],
  Surcharge: ['listPrice', 'listPriceIncludesTax', 'taxLines'],
  ShippingLine: ['listPrice', 'listPriceIncludesTax', 'adjustments', 'taxLines'],
} as const;

// tallySaleAt is timestamp without time zone holding the Node process's wall time (node-pg writes a Date in local time);
// Refund.createdAt holds the Postgres session's wall time (now()). Both become real instants before any comparison.
const SALE_AT = '(o.customFields.tallySaleAt AT TIME ZONE :writerZone)';
const REFUND_AT = "(refund.createdAt AT TIME ZONE current_setting('TimeZone'))";
const dayKey = (instant: string) => `to_char(${instant} AT TIME ZONE :timezone, 'YYYY-MM-DD')`;
const SALE_METHOD = "COALESCE(CAST(p.metadata AS jsonb) -> 'tender' ->> 'method', p.method)";
const REFUND_METHOD = "COALESCE(CAST(refund.metadata AS jsonb) ->> 'tallyMethod', CAST(payment.metadata AS jsonb) -> 'tender' ->> 'method', payment.method)";
// SUM and COUNT come back from Postgres as strings (bigint/numeric); money stays integer minor units.
const minor = (value: string | null | undefined) => Number(value ?? 0);

/** GET /tally/v1/reports/sales: the channel's POS sales and refunds in a range, every figure but discounts a SQL aggregate. */
@Injectable()
export class ReportService {
  // The zone node-pg wrote tallySaleAt in, read once.
  private readonly writerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private readonly rawPage = RAW_PAGE;

  constructor(private connection: TransactionalConnection, private ids: OrderCreateService) {}

  async sales(ctx: RequestContext, query: SalesQuery): Promise<TallySalesReport> {
    const params = { timezone: query.timezone };
    const days = await this.posOrders(ctx, query)
      .select(dayKey(SALE_AT), 'day')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(o.subTotalWithTax + o.shippingWithTax)', 'sales')
      .addSelect('SUM(o.subTotalWithTax - o.subTotal + o.shippingWithTax - o.shipping)', 'tax')
      .setParameters(params).groupBy(dayKey(SALE_AT))
      .getRawMany<{ day: string; count: string; sales: string | null; tax: string | null }>();
    const discounts = await this.discountsOf(ctx, this.posOrders(ctx, query));
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
    const orders = { count: 0, salesMinor: 0, taxMinor: 0, discountsMinor: discounts };
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

  // Gross to match salesMinor: priceWithTax is Vendure's gross-up from stored taxLines, whatever the command version stored.
  private async discountsOf(ctx: RequestContext, orders: SelectQueryBuilder<Order>): Promise<number> {
    const surcharges = await this.connection.getRepository(ctx, Surcharge).createQueryBuilder('s').innerJoin('s.order', 'discountOrder')
      .where(`discountOrder.id IN (${orders.select('o.id').getQuery()}) AND s.sku = :discountSku`, { ...orders.getParameters(), discountSku: TALLY_DISCOUNT_SKU }).getMany();
    return surcharges.reduce((sum, s) => sum - s.priceWithTax, 0);
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
    const builder = channelRefunds(this.connection, ctx)
      .andWhere('sale.customFields.tallyClientOrderId IS NOT NULL')
      .andWhere('sale.currencyCode = :currency', { currency: ctx.channel.defaultCurrencyCode })
      .andWhere(`${REFUND_AT} >= CAST(:from AS timestamptz)`, { from: query.from })
      .andWhere(`${REFUND_AT} < CAST(:to AS timestamptz)`, { to: query.to });
    // A dashboard refund carries no register id, so it counts under its sale's register.
    return query.registerId === undefined ? builder : builder.andWhere(
      "COALESCE(CAST(refund.metadata AS jsonb) ->> 'tallyRegisterId', sale.customFields.tallyRegisterId) = :registerId",
      { registerId: query.registerId });
  }

  /** GET /tally/v1/reports/sales/v2. Every figure is built on posOrdersV2/posRefundsV2, so every filter applies to all of them. */
  async salesV2(ctx: RequestContext, query: SalesQueryV2): Promise<TallySalesReportV2> {
    return (await this.loadV2(ctx, query)).report;
  }

  /** GET /tally/v1/reports/sales/v3: v2's report from the same loader, so the two cannot drift. */
  async salesV3(ctx: RequestContext, query: SalesQueryV2): Promise<TallySalesReportV3> {
    const { report, orderTotals, sold } = await this.loadV2(ctx, query);
    const totals = [...orderTotals].sort((a, b) => a - b);
    const mid = totals.length >> 1;
    const medianMinor = !totals.length ? 0 : totals.length % 2 ? totals[mid] : Math.round((totals[mid - 1] + totals[mid]) / 2);
    const largestMinor = totals.length ? totals[totals.length - 1] : null;
    return {
      ...report, version: 3, orders: { ...report.orders, medianMinor, largestMinor },
      categories: await this.categories(ctx, sold),
    };
  }

  /** Sold lines by collection: each variant's quantity and amount added to every collection of it in the channel. */
  private async categories(ctx: RequestContext, sold: Array<{ id: ID; quantity: number; salesMinor: number }>) {
    const pairs = sold.length ? await this.connection.getRepository(ctx, Collection).createQueryBuilder('c')
      .innerJoin('c.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
      .innerJoin('c.productVariants', 'v')
      .where('v.id = ANY(:variantIds)', { variantIds: sold.map(row => row.id) })
      .select('c.id', 'collectionId').addSelect('v.id', 'variantId')
      .getRawMany<{ collectionId: ID; variantId: ID }>() : [];
    const byVariant = new Map(sold.map(row => [String(row.id), row]));
    const rows = new Map<string, TallySalesReportV3['categories'][number] & { id: ID }>();
    for (const { collectionId, variantId } of pairs) {
      const line = byVariant.get(String(variantId))!;
      const row = rows.get(String(collectionId)) ?? rows.set(String(collectionId), {
        id: collectionId, collectionId: this.ids.encodeId(collectionId), name: '', quantity: 0, salesMinor: 0,
      }).get(String(collectionId))!;
      row.quantity += line.quantity;
      row.salesMinor += line.salesMinor;
    }
    const collections = rows.size ? await this.connection.getRepository(ctx, Collection).find({
      where: { id: In([...rows.values()].map(row => row.id)) }, relations: { translations: true },
    }) : [];
    const names = new Map(collections.map(collection => [String(collection.id),
      translateEntity(collection, [ctx.languageCode, ctx.channel.defaultLanguageCode]).name]));
    const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...rows.values()].map(({ id, ...row }) => ({ ...row, name: names.get(String(id)) ?? '' }))
      .sort((a, b) => b.salesMinor - a.salesMinor || ascending(a.name, b.name) || ascending(a.collectionId, b.collectionId));
  }

  /** v2's report, plus each counted order's total and every sold variant (unsliced) for v3. */
  private async loadV2(ctx: RequestContext, query: SalesQueryV2) {
    const params = { timezone: query.timezone };
    const hours = await this.posOrdersV2(ctx, query)
      .select(hourKey(SALE_AT), 'hour')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(o.subTotalWithTax + o.shippingWithTax)', 'sales')
      .addSelect('SUM(o.subTotalWithTax - o.subTotal + o.shippingWithTax - o.shipping)', 'tax')
      .setParameters(params).groupBy(hourKey(SALE_AT))
      .getRawMany<{ hour: string; count: string; sales: string | null; tax: string | null }>();
    const [items] = await this.posOrdersV2(ctx, query).innerJoin('o.lines', 'l')
      .select('SUM(l.quantity)', 'items').getRawMany<{ items: string | null }>();
    const discounts = await this.discountsOf(ctx, this.posOrdersV2(ctx, query));
    const methods = await this.posOrdersV2(ctx, query)
      .innerJoin('o.payments', 'p')
      .andWhere("p.state = 'Settled'")
      .select(SALE_METHOD, 'method')
      .addSelect('SUM(p.amount)', 'sales')
      .addSelect('COUNT(DISTINCT o.id)', 'orders')
      .groupBy(SALE_METHOD)
      .getRawMany<{ method: string; sales: string | null; orders: string }>();
    const refunds = await this.posRefundsV2(ctx, query)
      .select(hourKey(REFUND_AT), 'hour')
      .addSelect(REFUND_METHOD, 'method')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(refund.total)', 'total')
      .setParameters(params).groupBy(hourKey(REFUND_AT)).addGroupBy(REFUND_METHOD)
      .getRawMany<{ hour: string; method: string; count: string; total: string | null }>();
    const [refunded] = await this.posRefundsV2(ctx, query)
      .select('COUNT(DISTINCT sale.id)', 'orders').getRawMany<{ orders: string }>();

    type Row = { orderCount: number; salesMinor: number; refundsMinor: number };
    const bucket = <T extends Row>(map: Map<string, T>, key: string, make: () => T) => map.get(key) ?? map.set(key, make()).get(key)!;
    const byHour = new Map<string, TallySalesReportV2['byHour'][number]>();
    const hourOf = (hour: string) => bucket(byHour, hour, () => ({ hour, orderCount: 0, salesMinor: 0, refundsMinor: 0 }));
    const byMethod = new Map<string, TallySalesReportV2['byMethod'][number]>();
    const methodOf = (method: string) => bucket(byMethod, method,
      () => ({ method, salesMinor: 0, refundsMinor: 0, orderCount: 0, refundCount: 0 }));
    const orders = { count: 0, salesMinor: 0, taxMinor: 0, discountsMinor: discounts, itemCount: minor(items?.items) };
    for (const row of hours) {
      const entry = hourOf(row.hour);
      entry.orderCount += minor(row.count);
      entry.salesMinor += minor(row.sales);
      orders.count += minor(row.count);
      orders.salesMinor += minor(row.sales);
      orders.taxMinor += minor(row.tax);
    }
    for (const row of methods) Object.assign(methodOf(row.method), { salesMinor: minor(row.sales), orderCount: minor(row.orders) });
    const refundTotals = { count: 0, totalMinor: 0, orderCount: minor(refunded?.orders) };
    for (const row of refunds) {
      hourOf(row.hour).refundsMinor += minor(row.total);
      const method = methodOf(row.method);
      method.refundsMinor += minor(row.total);
      method.refundCount += minor(row.count);
      refundTotals.count += minor(row.count);
      refundTotals.totalMinor += minor(row.total);
    }
    // A day is its hours' date in the same zone, so the day and hour rows always add up alike.
    const byDay = new Map<string, TallySalesReport['byDay'][number]>();
    for (const hour of byHour.values()) {
      const day = bucket(byDay, hour.hour.slice(0, 10), () => ({ day: hour.hour.slice(0, 10), orderCount: 0, salesMinor: 0, refundsMinor: 0 }));
      day.orderCount += hour.orderCount;
      day.salesMinor += hour.salesMinor;
      day.refundsMinor += hour.refundsMinor;
    }
    const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const { products, productsTruncated, taxes, orderTotals, sold } = await this.linesAndTaxes(ctx, query, ascending);
    const report: TallySalesReportV2 = {
      version: 2, from: query.from, to: query.to, timezone: query.timezone, currencyCode: ctx.channel.defaultCurrencyCode,
      registerId: query.registerId ?? null, cashierId: query.cashierId ?? null, orders, refunds: refundTotals,
      byMethod: [...byMethod.values()].sort((a, b) => ascending(a.method, b.method)),
      byDay: [...byDay.values()].sort((a, b) => ascending(a.day, b.day)),
      byHour: [...byHour.values()].sort((a, b) => ascending(a.hour, b.hour)),
      products, productsTruncated, taxes,
    };
    return { report, orderTotals, sold };
  }

  private async ordersFind(ctx: RequestContext, ids: ID[]): Promise<Order[]> {
    // Only the relations Order.taxSummary reads (lines, surcharges, shipping lines).
    return this.connection.getRepository(ctx, Order).find({
      where: { id: In(ids) }, relations: { lines: true, surcharges: true, shippingLines: true },
    });
  }

  private async ordersRaw(ctx: RequestContext, ids: ID[]): Promise<Order[]> {
    const driver = this.connection.rawConnection.driver;
    const orders = new Map<string, Order>();
    for (const [Entity, keys] of [
      [Order, RAW_KEYS.Order], [OrderLine, RAW_KEYS.OrderLine],
      [Surcharge, RAW_KEYS.Surcharge], [ShippingLine, RAW_KEYS.ShippingLine],
    ] as const) {
      const repository = this.connection.getRepository<Order | OrderLine | Surcharge | ShippingLine>(ctx, Entity);
      const builder = repository.createQueryBuilder('row');
      const columns = keys.map(key => {
        const column = repository.metadata.findColumnWithPropertyName(key);
        if (!column) throw new Error(`raw copy lacks ${Entity.name}.${key} column`);
        return { key, column };
      });
      const fk = Entity === Order ? undefined : repository.metadata.findRelationWithPropertyPath('order')?.joinColumns[0];
      if (Entity !== Order && !fk) throw new Error(`raw copy lacks ${Entity.name}.order relation column`);
      builder.select([]);
      for (const { key, column } of columns) {
        builder.addSelect(`${builder.escape('row')}.${builder.escape(column.databaseName)}`, key);
      }
      if (fk) builder.addSelect(`${builder.escape('row')}.${builder.escape(fk.databaseName)}`, 'order_fk');
      const filterColumn = fk ?? columns[0].column;
      const rows = await builder.where(`${builder.escape('row')}.${builder.escape(filterColumn.databaseName)} = ANY(:ids)`, { ids })
        .getRawMany<Record<string, unknown>>();
      for (const row of rows) {
        const copied = Object.fromEntries(columns.map(({ key, column }) => [key, driver.prepareHydratedValue(row[key], column)]));
        if (Entity === Order) {
          const order = new Order({ ...copied, lines: [], surcharges: [], shippingLines: [] });
          orders.set(String(order.id), order);
        } else {
          const order = orders.get(String(driver.prepareHydratedValue(row.order_fk, fk!)))!;
          if (Entity === OrderLine) order.lines.push(new OrderLine(copied));
          else if (Entity === Surcharge) order.surcharges.push(new Surcharge(copied));
          else order.shippingLines.push(new ShippingLine(copied));
        }
      }
    }
    // An order deleted after the id query has no row: skip it, as find does (#481).
    return ids.flatMap(id => orders.get(String(id)) ?? []);
  }

  /** Products and tax rows from the matching orders, loaded in pages by id. */
  private async linesAndTaxes(ctx: RequestContext, query: SalesQueryV2, ascending: (a: string, b: string) => number) {
    const products = new Map<string, TallySalesReportV2['products'][number] & { id: ID }>();
    const taxes = new Map<string, TallySalesReportV2['taxes'][number]>();
    const orderTotals: number[] = [];
    // One id query instead of one per page (#481); ids alone are small.
    const ids = (await this.posOrdersV2(ctx, query).select('o.id', 'id').orderBy('o.id', 'ASC').getRawMany<{ id: ID }>()).map(row => row.id);
    // Postgres only: the raw reads bind = ANY(:ids); other databases keep find.
    const raw = this.connection.rawConnection.options.type === 'postgres';
    const pageSize = raw ? this.rawPage : ORDER_PAGE;
    for (let start = 0; start < ids.length; start += pageSize) {
      const slice = ids.slice(start, start + pageSize);
      const loaded = await (raw ? this.ordersRaw(ctx, slice) : this.ordersFind(ctx, slice));
      for (const order of loaded) {
        orderTotals.push(order.subTotalWithTax + order.shippingWithTax);
        for (const line of order.lines) {
          const product = products.get(String(line.productVariantId)) ?? products.set(String(line.productVariantId), {
            id: line.productVariantId, productVariantId: this.ids.encodeId(line.productVariantId), sku: '',
            name: '', quantity: 0, salesMinor: 0,
          }).get(String(line.productVariantId))!;
          product.quantity += line.quantity;
          product.salesMinor += line.proratedLinePriceWithTax;
        }
        for (const row of order.taxSummary) {
          const key = `${row.description}\u0000${row.taxRate}`;
          const tax = taxes.get(key) ?? taxes.set(key, { description: row.description, ratePercent: row.taxRate, baseMinor: 0, taxMinor: 0 }).get(key)!;
          tax.baseMinor += row.taxBase;
          tax.taxMinor += row.taxTotal;
        }
      }
    }
    if (products.size) {
      const skus = await this.connection.getRepository(ctx, ProductVariant).createQueryBuilder('v')
        .select('v.id', 'id').addSelect('v.sku', 'sku')
        .where('v.id = ANY(:ids)', { ids: [...products.values()].map(row => row.id) })
        .getRawMany<{ id: ID; sku: string }>();
      for (const { id, sku } of skus) products.get(String(id))!.sku = sku;
    }
    const sorted = [...products.values()].sort((a, b) => b.salesMinor - a.salesMinor || ascending(a.sku, b.sku)
      || ascending(a.productVariantId, b.productVariantId));
    const kept = sorted.slice(0, MAX_PRODUCTS);
    // Names only for the rows kept, in the request's language, else the channel's.
    const variants = kept.length ? await this.connection.getRepository(ctx, ProductVariant).find({
      where: { id: In(kept.map(row => row.id)) }, relations: { translations: true },
    }) : [];
    const names = new Map(variants.map(variant => [String(variant.id),
      translateEntity(variant, [ctx.languageCode, ctx.channel.defaultLanguageCode]).name]));
    return {
      products: kept.map(({ id, ...row }) => ({ ...row, name: names.get(String(id)) ?? '' })),
      productsTruncated: sorted.length > MAX_PRODUCTS,
      taxes: [...taxes.values()].sort((a, b) => a.ratePercent - b.ratePercent || ascending(a.description, b.description)),
      orderTotals, sold: sorted,
    };
  }

  /** posOrders, plus the sale's own till cashier when the query names one. */
  private posOrdersV2(ctx: RequestContext, query: SalesQueryV2) {
    const builder = this.posOrders(ctx, query);
    return query.cashierId === undefined ? builder
      : builder.andWhere('o.customFields.tallyCashierRef = :cashierId', { cashierId: query.cashierId });
  }

  /**
   * posRefunds, plus the cashier when the query names one: the refund's own till cashier (tallyCashierRef in the refund
   * metadata, written by withTallyRefund when the refund command carried cashierRef), else its sale's tallyCashierRef,
   * as v1's register rule.
   */
  private posRefundsV2(ctx: RequestContext, query: SalesQueryV2) {
    const builder = this.posRefunds(ctx, query);
    return query.cashierId === undefined ? builder : builder.andWhere(
      "COALESCE(CAST(refund.metadata AS jsonb) ->> 'tallyCashierRef', sale.customFields.tallyCashierRef) = :cashierId",
      { cashierId: query.cashierId });
  }
}
