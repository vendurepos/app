import { Injectable } from '@nestjs/common';
import {
  ConfigService, CustomerService, ID, Order, OrderCalculator, OrderLine, OrderService, PaymentMethod, PaymentService,
  ProductVariant, ProductVariantService, RequestContext, ShippingLine, ShippingMethod, StockLevelService,
  StockLocationService, StockMovementService, Surcharge, TaxRate, TransactionalConnection,
  isGraphQlErrorResult, manualFulfillmentHandler,
} from '@vendure/core';
import type { CurrencyCode } from '@vendure/core';
import { IsNull } from 'typeorm';
import { TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE } from '../config/strategies';
import { TallyCommand } from '../entities/tally-command.entity';
import type { CommandEnvelope, CommandResult, CommandWarning, OrderCreatePayload } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { fiscalFiguresErrors } from '../vendored/fiscal-figures';
import { payloadShapeErrors } from '../vendored/payload-shape';
import { ratePpmFromPercent } from '../vendored/tax-exact';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../vendored/versions';
import {
  BusinessRejection, StoreConfigurationRefusal, TransientCommandError, internalErrorFor, isUniqueViolation,
  transientKind, unwrap,
} from './errors';
import { roundHalfAwayFromZero } from './rounding';
import { MAX_MINOR, valueRangeErrors } from './value-ranges';

/** Additive warnings (S1 finding 5) until TallyUI's CommandWarning carries them (2.2.0). */
export type TotalWarning =
  | { code: 'total_mismatch'; expectedMinor: number; serverMinor: number; bridgeMinor: number }
  | { code: 'tax_rate_mismatch'; ratePpm: number; expectedMinor: number; serverMinor: number };

export type OrderCreateResult = CommandResult & { totalWarnings?: TotalWarning[] };

export type PricingStage = 'addItemToOrder' | 'setShippingMethod' | 'surchargeSave' | 'finalPass' | 'payments';

export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';
// ADR 0002 §2: a second claim for the same id waits this long on the uncommitted row.
const CLAIM_LOCK_TIMEOUT = '5s';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rejected = (id: string, code: string, message: string, data?: Record<string, unknown>): OrderCreateResult =>
  ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
const storeConfiguration = (id: string) => rejected(id, 'store_configuration',
  'Missing POS payment, shipping, or usable default-zone tax rates');

@Injectable()
export class OrderCreateService {
  /** Test seam: observes the order inside the command's transaction after each pricing stage. */
  testObserver?: (stage: PricingStage, ctx: RequestContext, order: Order) => Promise<void>;
  private clientOrderIdConstraint?: string;

  constructor(
    private connection: TransactionalConnection,
    private customers: CustomerService,
    private orders: OrderService,
    private calculator: OrderCalculator,
    private payments: PaymentService,
    private variants: ProductVariantService,
    private stockLocations: StockLocationService,
    private stockLevels: StockLevelService,
    private stockMovements: StockMovementService,
    private config: ConfigService,
  ) {}

  /**
   * Runs one order.create command in its own transaction (ADR 0002 §2). Returns the command's
   * result; throws TransientCommandError for connection, lock and timeout failures only.
   */
  async create(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<OrderCreateResult> {
    const invalid = this.shapeRefusal(command);
    if (invalid) return invalid;
    const { payload } = command;
    try {
      // Review 1: a command the ledger already holds skips every pre-claim check and replays.
      if (!await this.connection.getRepository(ctx, TallyCommand).findOneBy({ id: command.id })) {
        const requeued = await this.existingOrderResult(ctx, command);
        if (requeued) return requeued;
        if (!ctx.channel.availableCurrencyCodes.includes(payload.currency as CurrencyCode)) {
          return rejected(command.id, 'unsupported_currency', `The channel does not offer ${payload.currency}`);
        }
        if (!await this.storeCanSell(ctx)) return storeConfiguration(command.id);
      }
      // ADR 0002 "Currency": set before any line is added. A fresh context has no transaction.
      const commandCtx = new RequestContext({
        req: ctx.req, apiType: ctx.apiType, channel: ctx.channel, session: ctx.session,
        languageCode: ctx.languageCode, currencyCode: payload.currency as CurrencyCode,
        isAuthorized: ctx.isAuthorized, authorizedAsOwnerOnly: ctx.authorizedAsOwnerOnly,
      });
      let claimed = false;
      try {
        return await this.connection.withTransaction(commandCtx, async txCtx => {
          const replay = await this.claim(txCtx, command);
          if (replay) return replay;
          claimed = true;
          return await this.recipe(txCtx, command);
        });
      } catch (error) {
        if (error instanceof StoreConfigurationRefusal) return storeConfiguration(command.id);
        if (error instanceof BusinessRejection) return await this.storeRejection(commandCtx, command, error);
        // Two commands for one sale raced; the other committed first (ADR 0002 §2 "Requeue path").
        if (isUniqueViolation(error, this.clientOrderIdIndex())) {
          const existing = await this.existingOrderResult(commandCtx, command);
          if (existing) return existing;
          // Review 10: the sale is recorded in another channel, which this caller cannot answer for.
          const elsewhere = await this.connection.getRepository(commandCtx, Order).count({
            where: { customFields: { tallyClientOrderId: payload.clientOrderId } },
          });
          if (elsewhere) {
            return await this.storeRejection(commandCtx, command, new BusinessRejection('idempotency_mismatch',
              'The clientOrderId is already recorded in another channel', { reason: 'client_order_in_other_channel' }));
          }
        }
        // Ruling 8: an unexpected exception after the claim is final too, or it would loop.
        if (claimed && !transientKind(error)) {
          return await this.storeRejection(commandCtx, command, internalErrorFor(command.id, error));
        }
        throw error;
      }
    } catch (error) {
      const kind = error instanceof TransientCommandError ? undefined : transientKind(error);
      if (kind) throw new TransientCommandError(command.id, kind, error);
      throw error;
    }
  }

  // ADR 0002 §2 step 2: shape and version refusals, answered before any write or claim.
  private shapeRefusal(command: CommandEnvelope<OrderCreatePayload>): OrderCreateResult | undefined {
    const id = typeof command?.id === 'string' ? command.id : '';
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return rejected(id, 'invalid_payload', 'Expected command object');
    }
    const errors: string[] = [];
    if (!id.length || id.length > 64) errors.push('Invalid id');
    if (command.type !== 'order.create') errors.push('type: expected order.create');
    if (!Number.isSafeInteger(command.version) || command.version < 1) errors.push('Invalid version');
    if (typeof command.createdAt !== 'string') errors.push('Invalid createdAt');
    if (typeof command.deviceId !== 'string') errors.push('Invalid deviceId');
    if (!Number.isSafeInteger(command.attempt) || command.attempt < 1) errors.push('Invalid attempt');
    if (!errors.length && !SUPPORTED_ORDER_CREATE_VERSIONS.includes(command.version)) {
      return rejected(id, 'unsupported_version', 'Unsupported order.create version',
        { orderCreate: Math.max(...SUPPORTED_ORDER_CREATE_VERSIONS) });
    }
    errors.push(...payloadShapeErrors(command.payload));
    if (!errors.length) errors.push(...valueRangeErrors(command.payload));
    if (!errors.length && command.version === 3) errors.push(...fiscalFiguresErrors(command.payload));
    return errors.length ? rejected(id, 'invalid_payload', errors.join('; ')) : undefined;
  }

  // ADR 0002 "Store configuration": the POS payment and shipping methods and a usable tax zone.
  private async storeCanSell(ctx: RequestContext): Promise<boolean> {
    const payment = await this.connection.getRepository(ctx, PaymentMethod).findOne({
      where: { code: TALLY_PAYMENT_METHOD_CODE, enabled: true, channels: { id: ctx.channelId } },
    });
    const shipping = await this.connection.getRepository(ctx, ShippingMethod).findOne({
      where: { code: TALLY_SHIPPING_METHOD_CODE, deletedAt: IsNull(), channels: { id: ctx.channelId } },
    });
    const zone = ctx.channel.defaultTaxZone;
    const rates = zone && await this.connection.getRepository(ctx, TaxRate).count({
      where: { zoneId: zone.id, enabled: true, customerGroup: IsNull() },
    });
    return !!payment && !!shipping && !!rates;
  }

  /** The requeue answer: `applied` with the refs of the order already made for this sale. */
  private async existingOrderResult(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>) {
    const order = await this.connection.getRepository(ctx, Order).findOne({
      where: { customFields: { tallyClientOrderId: command.payload.clientOrderId }, channels: { id: ctx.channelId } },
    });
    return order ? { id: command.id, status: 'applied', serverRefs: {
      orderId: this.encodeId(order.id), displayId: order.code, totalMinor: order.totalWithTax,
    } } satisfies OrderCreateResult : undefined;
  }

  // Review 2: ids cross the wire in the configured EntityIdStrategy's encoding, as the Admin API
  // gives them. An id the strategy would not have issued decodes to undefined.
  private decodeId(id: string): ID | undefined {
    const strategy = this.idStrategy();
    let decoded: unknown;
    try {
      decoded = strategy.decodeId(id);
    } catch {
      return undefined;
    }
    const valid = strategy.primaryKeyType === 'uuid'
      ? typeof decoded === 'string' && UUID.test(decoded)
      : Number.isSafeInteger(decoded) && (decoded as number) > 0 && (decoded as number) <= MAX_MINOR;
    return valid && String(strategy.encodeId(decoded as never)) === id ? decoded as ID : undefined;
  }

  private encodeId(id: ID): string {
    return String(this.idStrategy().encodeId(id as never));
  }

  // As Vendure's own IdCodecService picks it: entityOptions first, then the deprecated top level.
  private idStrategy() {
    return this.config.entityOptions.entityIdStrategy ?? this.config.entityIdStrategy;
  }

  // ADR 0002 §2 "The claim": Postgres-only. A second claim for the id waits on the uncommitted row.
  private async claim(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<OrderCreateResult | undefined> {
    const repository = this.connection.getRepository(ctx, TallyCommand);
    const runner = repository.manager.queryRunner!;
    const table = repository.metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
    const fingerprint = commandFingerprint(command);
    await runner.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
    const rows = await runner.query(
      `INSERT INTO ${table} ("id", "clientOrderId", "fingerprint", "status") VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [command.id, command.payload.clientOrderId, fingerprint, 'pending'],
    );
    await runner.query('SET LOCAL lock_timeout = DEFAULT');
    if (rows.length) return undefined;
    const existing = await repository.findOneByOrFail({ id: command.id });
    if (existing.fingerprint !== fingerprint) {
      return rejected(command.id, 'idempotency_mismatch', 'Command id was already used with a different payload');
    }
    const stored = existing.result as unknown as OrderCreateResult;
    return { ...stored, status: existing.status === 'rejected' ? 'rejected' : 'duplicate' };
  }

  // The failed order transaction has rolled back, including its claim; store the final answer.
  private async storeRejection(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>, error: BusinessRejection) {
    const result = rejected(command.id, error.code, error.message, error.data);
    return this.connection.withTransaction(ctx, async txCtx => {
      const replay = await this.claim(txCtx, command);
      if (replay) return replay;
      await this.connection.getRepository(txCtx, TallyCommand).update(command.id, { status: 'rejected', result: { ...result } });
      return result;
    });
  }

  private clientOrderIdIndex(): string {
    this.clientOrderIdConstraint ??= this.connection.rawConnection.getMetadata(Order).uniques
      .find(unique => unique.columns.some(column => column.propertyPath === 'customFields.tallyClientOrderId'))?.name ?? '';
    return this.clientOrderIdConstraint;
  }

  // The S1 recipe (docs/spikes/s1-order-recipe.md). Its money and tax logic is unchanged; VP1 adds
  // the refused-PaymentSettled mapping, id decoding and the live-shipping-method lookup.
  private async recipe(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<OrderCreateResult> {
    const payload = command.payload;
    const customerId = payload.customer?.customerId ? this.decodeId(payload.customer.customerId) : undefined;
    let customer = customerId !== undefined ? await this.customers.findOne(ctx, customerId) : undefined;
    if (!customer) {
      const emailAddress = payload.customer?.email || WALK_IN_EMAIL;
      const existing = await this.customers.findAll(ctx, { filter: { emailAddress: { eq: emailAddress } } });
      customer = unwrap(await this.customers.createOrUpdate(ctx, {
        emailAddress,
        firstName: existing.items[0]?.firstName ?? '', lastName: existing.items[0]?.lastName ?? '',
      }));
    }
    let order = await this.orders.createDraft(ctx);
    order.customer = customer;
    order.customFields = {
      ...order.customFields,
      tallyClientOrderId: payload.clientOrderId,
      tallySaleAt: new Date(payload.createdAt),
      tallyRegisterId: payload.registerId,
      tallySessionId: command.version === 3 ? payload.sessionId : undefined,
      tallyCashierRef: payload.cashierRef,
    };
    await this.connection.getRepository(ctx, Order).save(order);
    const requested = new Map<string, { variant: ProductVariant; quantity: number }>();
    for (const line of payload.lines) {
      const id = this.decodeId(line.variantId);
      const variant = id === undefined ? null : await this.connection.getRepository(ctx, ProductVariant).findOne({
        where: { id, deletedAt: IsNull(), channels: { id: ctx.channelId } },
      });
      if (!variant || !variant.enabled) {
        throw new BusinessRejection('unknown_variant', `Variant ${line.variantId} is missing or disabled`);
      }
      const entry = requested.get(line.variantId) ?? { variant, quantity: 0 };
      requested.set(line.variantId, { variant, quantity: entry.quantity + line.quantity });
    }
    // ADR 0002 "Stock": top up a shortage before addItemToOrder, which would otherwise save the
    // line at the saleable quantity, and before ArrangingPayment, which checks saleable stock again.
    const location = await this.stockLocations.defaultStockLocation(ctx);
    const topUps: Array<{ variantId: string; id: ID; quantity: number }> = [];
    for (const [variantId, { variant, quantity }] of requested) {
      const shortfall = quantity - await this.variants.getSaleableStockLevel(ctx, variant);
      if (shortfall <= 0) continue;
      await this.adjustStock(ctx, variant.id, location.id, shortfall);
      topUps.push({ variantId, id: variant.id, quantity: shortfall });
    }
    for (const line of payload.lines) {
      const variantId = requested.get(line.variantId)!.variant.id;
      order = unwrap(await this.orders.addItemToOrder(ctx, order.id, variantId, line.quantity, {
        tallyUnitPrice: line.unitPriceMinor,
        tallyClientLineId: line.clientLineId,
        tallyPriceIncludesTax: line.taxInclusive ?? payload.pricesIncludeTax,
      }));
      await this.testObserver?.('addItemToOrder', ctx, order);
    }
    const shipping = await this.connection.getRepository(ctx, ShippingMethod).findOneOrFail({
      where: { code: TALLY_SHIPPING_METHOD_CODE, deletedAt: IsNull(), channels: { id: ctx.channelId } },
    });
    order = unwrap(await this.orders.setShippingMethod(ctx, order.id, [shipping.id]));
    await this.testObserver?.('setShippingMethod', ctx, order);
    for (const line of payload.lines) {
      if (!(line.discountMinor! > 0)) continue;
      const orderLine = order.lines.find(item => item.customFields.tallyClientLineId === line.clientLineId)!;
      const surcharge = await this.connection.getRepository(ctx, Surcharge).save(new Surcharge({
        order, description: 'POS discount', sku: 'TALLY-DISCOUNT', listPrice: -line.discountMinor!,
        listPriceIncludesTax: line.taxInclusive ?? payload.pricesIncludeTax,
        taxLines: orderLine.taxLines.map(({ taxRate, description }) => ({ taxRate, description })),
      }));
      order.surcharges.push(surcharge);
      await this.testObserver?.('surchargeSave', ctx, order);
    }
    // calculateOrderTotals reads surcharge.price/priceWithTax; these getters compute tax
    // from taxLines. applyTaxes only visits product lines, so attach surcharges above.
    order = await this.calculator.applyPriceAdjustments(ctx, order, []);
    const totalWarnings: TotalWarning[] = [];
    const serverMinor = order.totalWithTax;
    const bridgeMinor = payload.totalMinor - serverMinor;
    if (bridgeMinor !== 0) {
      const bridge = await this.connection.getRepository(ctx, Surcharge).save(new Surcharge({
        order, description: 'POS rounding', sku: 'TALLY-ROUNDING', listPrice: bridgeMinor,
        listPriceIncludesTax: true, taxLines: [],
      }));
      order.surcharges.push(bridge);
      this.calculator.calculateOrderTotals(order);
      totalWarnings.push({ code: 'total_mismatch', expectedMinor: payload.totalMinor, serverMinor, bridgeMinor });
    }
    if (command.version === 3) {
      // For an integer count, half-away rounding of count/2 equals ceil(count/2).
      const T = Number(roundHalfAwayFromZero(BigInt(order.lines.length + order.surcharges.length), 2n));
      const pos = new Map<number, number>();
      const vendure = new Map<number, number>();
      for (const rate of payload.taxByRate!) {
        pos.set(rate.ratePpm, (pos.get(rate.ratePpm) ?? 0) + rate.taxMinor);
      }
      for (const rate of order.taxSummary) {
        const ratePpm = ratePpmFromPercent(rate.taxRate);
        vendure.set(ratePpm, (vendure.get(ratePpm) ?? 0) + rate.taxTotal);
      }
      for (const ratePpm of new Set([...pos.keys(), ...vendure.keys()])) {
        const expectedMinor = pos.get(ratePpm) ?? 0;
        const serverRateMinor = vendure.get(ratePpm) ?? 0;
        if (Math.abs(serverRateMinor - expectedMinor) > T) {
          totalWarnings.push({ code: 'tax_rate_mismatch', ratePpm, expectedMinor, serverMinor: serverRateMinor });
        }
      }
    }
    await this.connection.getRepository(ctx, Order).save(order);
    await this.connection.getRepository(ctx, OrderLine).save(order.lines);
    await this.connection.getRepository(ctx, ShippingLine).save(order.shippingLines);
    await this.testObserver?.('finalPass', ctx, order);
    order = unwrap(await this.orders.transitionToState(ctx, order.id, 'ArrangingPayment'));

    // ADR-039: tenders above the total are allowed; the covering tender's payment is capped.
    let remaining = payload.totalMinor;
    for (const tender of payload.payments) {
      if (remaining === 0) break;
      const amount = Math.min(tender.amountMinor, remaining);
      unwrap(await this.payments.createPayment(ctx, order, amount, TALLY_PAYMENT_METHOD_CODE, { tender }));
      remaining -= amount;
    }
    order = (await this.orders.findOne(ctx, order.id))!;
    await this.testObserver?.('payments', ctx, order);
    if (order.state !== 'PaymentSettled') {
      const settled = await this.orders.transitionToState(ctx, order.id, 'PaymentSettled');
      // ADR 0002 §2: `underpaid` only when the payments really are below the bridged total.
      if (isGraphQlErrorResult(settled)) {
        const paidMinor = (await this.orders.getOrderPayments(ctx, order.id))
          .filter(payment => payment.state === 'Settled').reduce((sum, payment) => sum + payment.amount, 0);
        if (paidMinor < order.totalWithTax) {
          throw new BusinessRejection('underpaid', `Payments of ${paidMinor} are below the total of ${order.totalWithTax}`);
        }
        // Review 13: enough payment, so look for a configuration cause first; else platform_error.
        if (!await this.storeCanSell(ctx)) throw new StoreConfigurationRefusal();
      }
      order = unwrap(settled);
    }
    order.customFields.tallyPayments = JSON.stringify(payload.payments);
    order.orderPlacedAt = new Date(payload.createdAt);
    if (command.version === 3) {
      order.customFields.tallySnapshot = JSON.stringify({ display: payload.display, taxByRate: payload.taxByRate });
    }
    await this.connection.getRepository(ctx, Order).save(order);

    const fulfillment = unwrap(await this.orders.createFulfillment(ctx, {
      lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity })),
      handler: {
        code: manualFulfillmentHandler.code,
        arguments: [{ name: 'method', value: 'In-store collection' }, { name: 'trackingCode', value: '' }],
      },
    }));
    unwrap(await this.orders.transitionFulfillmentToState(ctx, fulfillment.id, 'Delivered'));
    for (const topUp of topUps) await this.adjustStock(ctx, topUp.id, location.id, -topUp.quantity);
    const warnings: CommandWarning[] = topUps.map(({ variantId, quantity }) => ({ code: 'insufficient_stock', variantId, quantity }));
    const result: OrderCreateResult = {
      id: command.id, status: 'applied',
      serverRefs: { orderId: this.encodeId(order.id), displayId: order.code, totalMinor: order.totalWithTax },
      ...(warnings.length ? { warnings } : {}),
      ...(totalWarnings.length ? { totalWarnings } : {}),
    };
    await this.connection.getRepository(ctx, TallyCommand).save({
      id: command.id, clientOrderId: payload.clientOrderId, fingerprint: commandFingerprint(command),
      status: 'applied', result: { ...result },
    });
    return result;
  }

  private async adjustStock(ctx: RequestContext, variantId: ID, stockLocationId: ID, change: number) {
    const level = await this.stockLevels.getStockLevel(ctx, variantId, stockLocationId);
    await this.stockMovements.adjustProductVariantStock(ctx, variantId, [
      { stockLocationId, stockOnHand: level.stockOnHand + change },
    ]);
  }
}
