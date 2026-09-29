import { Injectable } from '@nestjs/common';
import {
  ConfigService, CustomerService, ID, Logger, Order, OrderCalculator, OrderLine, OrderService, PaymentMethod, PaymentService,
  ProductVariant, ProductVariantService, RequestContext, ShippingLine, ShippingMethod, StockLevelService,
  StockLocationService, StockMovementService, Surcharge, TaxRate, TransactionalConnection,
  isGraphQlErrorResult, manualFulfillmentHandler,
} from '@vendure/core';
import type { CurrencyCode } from '@vendure/core';
import { In, IsNull } from 'typeorm';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, isTallyRoute, markTallyRoute, tallyPaymentChecker, tallyShippingChecker,
} from '../config/strategies';
import { TallyCommand } from '../entities/tally-command.entity';
import type { CommandEnvelope, CommandResult, CommandWarning, OrderCreatePayload } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { fiscalFiguresErrors } from '../vendored/fiscal-figures';
import { payloadShapeErrors } from '../vendored/payload-shape';
import { ratePpmFromPercent } from '../vendored/tax-exact';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../vendored/versions';
import { classify } from './classification';
import {
  BusinessRejection, PLATFORM_ERROR_CODE, StoreConfigurationRefusal, TransientCommandError, internalErrorFor, loggerCtx,
  transientKind, unwrap,
} from './errors';
import { roundHalfAwayFromZero } from './rounding';
import { MAX_INT4, maxMoneyMinor, valueRangeErrors } from './value-ranges';

/** Additive warnings (S1 finding 5) until TallyUI's CommandWarning carries them (2.2.0). */
export type TotalWarning =
  | { code: 'total_mismatch'; expectedMinor: number; serverMinor: number; bridgeMinor: number }
  | { code: 'tax_rate_mismatch'; ratePpm: number; expectedMinor: number; serverMinor: number };

export type OrderCreateResult = CommandResult & { totalWarnings?: TotalWarning[] };

export type PricingStage = 'addItemToOrder' | 'setShippingMethod' | 'surchargeSave' | 'finalPass' | 'payments';

export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';
// ADR 0002 §2: a second claim for the same id waits this long on the uncommitted row.
const CLAIM_LOCK_TIMEOUT = '5s';
// Front desk ruling: a createdAt from the epoch up to now plus this skew, which absorbs a till
// whose clock runs ahead; anything later, earlier or unparseable is invalid_payload.
const CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
/** The environment variable that enables the test hooks; production never sets it. */
export const TEST_HOOKS_ENV = 'VENDUREPOS_PLUGIN_TEST_HOOKS';
// platformCode of an admin's `rejected` resolution of a needs_admin row.
const ADMIN_REJECTED = 'TALLY_ADMIN_REJECTED';

type TestHook = 'afterSavepointRollback' | 'afterCommit';
type SaleOutcome = { result: OrderCreateResult; needsAdmin?: boolean; compensationError?: unknown };

const createdAtError = (value: unknown, path: string) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return time >= 0 && time <= Date.now() + CREATED_AT_SKEW_MS ? []
    : [`${path}: expected a time from 1970-01-01T00:00:00Z to one day from now`];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rejected = (id: string, code: string, message: string, data?: Record<string, unknown>): OrderCreateResult =>
  ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });
const storeConfiguration = (id: string) => rejected(id, 'store_configuration',
  'Missing or reconfigured POS payment or shipping method, manual fulfilment handler, or usable default-zone tax rates');

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
   * result; throws TransientCommandError for every failure that may be retried (classification.ts),
   * and with kind `needs_admin` once a sale's compensation has failed.
   */
  async create(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<OrderCreateResult> {
    const invalid = this.shapeRefusal(command);
    if (invalid) return invalid;
    const { payload } = command;
    let outcome: SaleOutcome;
    try {
      // Front desk ordering ruling: 1. a command the ledger already holds replays (review 1); 2. a sale
      // recorded in any channel goes to the collision guard after the claim; 3. only then the checks below.
      if (!await this.connection.getRepository(ctx, TallyCommand).findOneBy({ id: command.id })
        && !await this.recordedAnywhere(ctx, payload.clientOrderId)) {
        const invalidValue = this.valueRefusal(command);
        if (invalidValue) return invalidValue;
        if (!ctx.channel.availableCurrencyCodes.includes(payload.currency as CurrencyCode)) {
          return rejected(command.id, 'unsupported_currency', `The channel does not offer ${payload.currency}`);
        }
        if (!await this.storeCanSell(ctx)) return storeConfiguration(command.id);
        const refusal = await this.deterministicRefusal(ctx, command);
        if (refusal) return refusal;
      }
      // ADR 0002 "Currency": set before any line is added. A fresh context has no transaction.
      const commandCtx = new RequestContext({
        req: ctx.req, apiType: ctx.apiType, channel: ctx.channel, session: ctx.session,
        languageCode: ctx.languageCode, currencyCode: payload.currency as CurrencyCode,
        isAuthorized: ctx.isAuthorized, authorizedAsOwnerOnly: ctx.authorizedAsOwnerOnly,
      });
      if (isTallyRoute(ctx)) markTallyRoute(commandCtx);
      outcome = await this.connection.withTransaction(commandCtx, async txCtx => {
        const replay = await this.claim(txCtx, command);
        if (replay) return { result: replay };
        const requeued = await this.requeueResult(txCtx, command);
        return requeued ? { result: requeued } : await this.runSale(txCtx, command);
      });
    } catch (error) {
      if (error instanceof StoreConfigurationRefusal) return storeConfiguration(command.id);
      if (error instanceof TransientCommandError) throw error;
      throw new TransientCommandError(command.id, transientKind(error) ?? 'unclassified', error);
    }
    if (outcome.needsAdmin) throw new TransientCommandError(command.id, 'needs_admin', outcome.compensationError);
    return outcome.result;
  }

  /**
   * TallyUI ADR-038's `platform_error` amendment: the sale's steps run in a savepoint after the
   * claim. A stored outcome rolls back to the savepoint, keeps the claim, stores the rejection on it
   * and commits, so a resend of the id waits on the claim and never runs the recipe a second time.
   */
  private async runSale(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<SaleOutcome> {
    try {
      // Vendure's withTransaction inside a transaction is a SAVEPOINT on the same query runner.
      return await this.connection.withTransaction(ctx, saleCtx => this.recipe(saleCtx, command));
    } catch (error) {
      // The savepoint has rolled back. Had the rollback failed, `error` would be that failure: transient.
      if (error instanceof TransientCommandError) throw error;
      const verdict = classify(error, this.clientOrderIdIndex());
      if (verdict.outcome === 'notStored') throw error;
      if (verdict.outcome === 'transient') {
        // N5: after the claim, a lock timeout is a timeout, not another request's claim.
        throw new TransientCommandError(command.id, verdict.kind === 'lock' ? 'timeout' : verdict.kind, error);
      }
      if (verdict.outcome === 'collision') {
        // Two commands for one sale raced and the other committed first (ADR 0002 §2 "Requeue path").
        const requeued = await this.requeueResult(ctx, command);
        if (requeued) return { result: requeued };
        throw new TransientCommandError(command.id, 'unclassified', error);
      }
      const rejection = verdict.rejection ?? internalErrorFor(command.id, error);
      const result = rejected(command.id, rejection.code, rejection.message, rejection.data);
      await this.runTestHook('afterSavepointRollback', command.id);
      await this.connection.getRepository(ctx, TallyCommand).update(command.id, { status: 'rejected', result: { ...result } });
      return { result };
    }
  }

  /**
   * Resolves a `needs_admin` ledger row (the amendment): `applied` replays the sale's stored refs as
   * `duplicate`; `rejected` replays a `platform_error` carrying the admin's note. Not exposed over
   * any API; a caller that exposes it must guard it with Permission.SuperAdmin.
   */
  async resolveNeedsAdmin(ctx: RequestContext, commandId: string, resolution: 'applied' | 'rejected', note: string) {
    return this.connection.withTransaction(ctx, async txCtx => {
      const ledger = this.connection.getRepository(txCtx, TallyCommand);
      const row = await ledger.findOne({ where: { id: commandId }, lock: { mode: 'pessimistic_write' } });
      if (row?.status !== 'needs_admin') throw new Error(`Command ${commandId} does not need an admin`);
      const stored = row.result as unknown as OrderCreateResult;
      if (resolution === 'rejected') {
        // Front desk ruling 4: a rejected row never keeps a live order. Vendure's cancellation (stock
        // restored as it restores it) and freeing the clientOrderId commit with the rejection, or not at all.
        const orderId = this.decodeId(stored.serverRefs!.orderId)!;
        const cancelled = await this.orders.cancelOrder(txCtx, { orderId, reason: note, cancelShipping: true });
        if (isGraphQlErrorResult(cancelled)) {
          throw new Error(`Command ${commandId} is not rejected: order ${stored.serverRefs!.displayId} cannot be cancelled `
            + `(${cancelled.errorCode}: ${cancelled.message})`);
        }
        await this.connection.getRepository(txCtx, Order).update(orderId, {
          customFields: { tallyClientOrderId: `${row.clientOrderId}#rejected:${commandId}` },
        });
      }
      const result = resolution === 'applied' ? stored
        : rejected(commandId, PLATFORM_ERROR_CODE, `${ADMIN_REJECTED}: ${note}`, { platformCode: ADMIN_REJECTED, platformMessage: note });
      await ledger.update(commandId, { status: resolution, result: { ...result } });
      Logger.warn(`order.create ${commandId}: needs_admin resolved as ${resolution} (${note})`, loggerCtx);
      return result;
    });
  }

  /** Test seams (VP2): they run only while VENDUREPOS_PLUGIN_TEST_HOOKS is '1', which production never sets. */
  testHooks: Partial<Record<TestHook, (commandId: string) => Promise<void>>> = {};

  async runTestHook(name: TestHook, commandId: string) {
    if (process.env[TEST_HOOKS_ENV] === '1') await this.testHooks[name]?.(commandId);
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
    return errors.length ? rejected(id, 'invalid_payload', errors.join('; ')) : undefined;
  }

  // Front desk ordering ruling, step 3: the payload's values, checked after the collision lookup.
  private valueRefusal(command: CommandEnvelope<OrderCreatePayload>): OrderCreateResult | undefined {
    const errors = createdAtError(command.createdAt, 'createdAt');
    const maxMoney = maxMoneyMinor(this.config.entityOptions.moneyStrategy?.moneyColumnOptions.type);
    if (!errors.length) errors.push(...createdAtError(command.payload.createdAt, 'payload.createdAt'));
    if (!errors.length) errors.push(...valueRangeErrors(command.payload, maxMoney));
    if (!errors.length && command.version === 3) errors.push(...fiscalFiguresErrors(command.payload));
    return errors.length ? rejected(command.id, 'invalid_payload', errors.join('; ')) : undefined;
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
    // Front desk ruling (A): the permanent-list configuration errors, found before any write. The
    // plugin's own checkers accept every POS order; a replaced checker or a missing manual handler would not.
    const checkers = (!payment?.checker || payment.checker.code === tallyPaymentChecker.code)
      && shipping?.checker.code === tallyShippingChecker.code
      && this.config.shippingOptions.fulfillmentHandlers.some(handler => handler.code === manualFulfillmentHandler.code);
    return !!payment && !!shipping && !!rates && checkers;
  }

  /**
   * Front desk ruling (A): the sale's deterministic refusals, answered before the claim so that
   * nothing is written and no event fires. Not stored, like `invalid_payload`. The recipe keeps
   * the same checks after the claim for races.
   */
  private async deterministicRefusal(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>) {
    const { lines, payments, totalMinor } = command.payload;
    const { orderItemsLimit, orderLineItemsLimit } = this.config.orderOptions;
    const items = lines.reduce((sum, line) => sum + line.quantity, 0);
    // Vendure's OrderLimitError conditions; POS lines stay 1:1 with order lines.
    if (items > orderItemsLimit || lines.some(line => line.quantity > orderLineItemsLimit)) {
      return rejected(command.id, 'invalid_payload',
        `lines: exceed orderOptions.orderItemsLimit ${orderItemsLimit} or orderLineItemsLimit ${orderLineItemsLimit}`);
    }
    // The bridge makes Vendure's total equal totalMinor, so the payload alone decides underpaid.
    const paidMinor = payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (paidMinor < totalMinor) return rejected(command.id, 'underpaid', `Payments of ${paidMinor} are below the total of ${totalMinor}`);
    for (const line of lines) {
      if (!await this.findVariant(ctx, line.variantId)) {
        return rejected(command.id, 'unknown_variant', `Variant ${line.variantId} is missing or disabled`);
      }
    }
    return undefined;
  }

  private async findVariant(ctx: RequestContext, variantId: string) {
    const id = this.decodeId(variantId);
    const variant = id === undefined ? null : await this.connection.getRepository(ctx, ProductVariant).findOne({
      where: { id, deletedAt: IsNull(), channels: { id: ctx.channelId } },
    });
    return variant?.enabled ? variant : undefined;
  }

  private async recordedAnywhere(ctx: RequestContext, clientOrderId: string) {
    return !!await this.connection.getRepository(ctx, Order).count({ where: { customFields: { tallyClientOrderId: clientOrderId } } });
  }

  private existingOrder(ctx: RequestContext, clientOrderId: string) {
    return this.connection.getRepository(ctx, Order).findOne({
      where: { customFields: { tallyClientOrderId: clientOrderId }, channels: { id: ctx.channelId } },
    });
  }

  /**
   * The collision guard (Front desk refinement 2), run on the claim of a new command id: a sale this
   * channel has recorded answers `applied` only when its own command's row is `applied`, and the new
   * id is then stored as `applied` with that result's refs and warnings, so its replay is `duplicate`.
   * A row awaiting an admin answers 409, so a new id never gets round the mark. A sale recorded in
   * another channel is a stored idempotency_mismatch (review 10). Without a recorded order, undefined.
   */
  private async requeueResult(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>) {
    const order = await this.existingOrder(ctx, command.payload.clientOrderId);
    const ledger = this.connection.getRepository(ctx, TallyCommand);
    if (!order) {
      if (!await this.recordedAnywhere(ctx, command.payload.clientOrderId)) return undefined;
      const mismatch = rejected(command.id, 'idempotency_mismatch', 'The clientOrderId is already recorded in another channel',
        { reason: 'client_order_in_other_channel' });
      await ledger.update(command.id, { status: 'rejected', result: { ...mismatch } });
      return mismatch;
    }
    const orderId = this.encodeId(order.id);
    const rows = await ledger.find({ where: {
      clientOrderId: command.payload.clientOrderId, channelId: String(ctx.channelId), status: In(['applied', 'needs_admin']),
    } });
    const source = rows.find(row => (row.result as OrderCreateResult | null)?.serverRefs?.orderId === orderId);
    if (source?.status === 'needs_admin') throw new TransientCommandError(command.id, 'needs_admin', undefined);
    // Unreachable by construction (an admin's rejection cancels the order and frees its clientOrderId): transient.
    if (!source) throw new TransientCommandError(command.id, 'unclassified', new Error(`Order ${orderId} has no applied command`));
    const { id: _id, status: _status, ...stored } = source.result as unknown as OrderCreateResult;
    const result: OrderCreateResult = { id: command.id, status: 'applied', ...stored };
    await ledger.update(command.id, { status: 'applied', result: { ...result } });
    return result;
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
      : Number.isSafeInteger(decoded) && (decoded as number) > 0 && (decoded as number) <= MAX_INT4;
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
      `INSERT INTO ${table} ("id", "channelId", "clientOrderId", "fingerprint", "status") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [command.id, String(ctx.channelId), command.payload.clientOrderId, fingerprint, 'pending'],
    );
    await runner.query('SET LOCAL lock_timeout = DEFAULT');
    if (rows.length) return undefined;
    const existing = await repository.findOneByOrFail({ id: command.id });
    // N6: another channel's command id never replays that channel's answer.
    if (existing.channelId !== String(ctx.channelId)) {
      return rejected(command.id, 'idempotency_mismatch', 'Command id was already used in another channel',
        { reason: 'command_in_other_channel' });
    }
    if (existing.fingerprint !== fingerprint) {
      return rejected(command.id, 'idempotency_mismatch', 'Command id was already used with a different payload');
    }
    // The amendment: a row awaiting an admin answers 409 in_progress, never duplicate or rejected.
    if (existing.status === 'needs_admin') throw new TransientCommandError(command.id, 'needs_admin', undefined);
    const stored = existing.result as unknown as OrderCreateResult;
    return { ...stored, status: existing.status === 'rejected' ? 'rejected' : 'duplicate' };
  }

  private clientOrderIdIndex(): string {
    this.clientOrderIdConstraint ??= this.connection.rawConnection.getMetadata(Order).uniques
      .find(unique => unique.columns.some(column => column.propertyPath === 'customFields.tallyClientOrderId'))?.name ?? '';
    return this.clientOrderIdConstraint;
  }

  // The S1 recipe (docs/spikes/s1-order-recipe.md). Its money and tax logic is unchanged; VP1 adds
  // the refused-PaymentSettled mapping, id decoding and the live-shipping-method lookup.
  private async recipe(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<SaleOutcome> {
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
    // The collision guard's in-progress case: another transaction still recording this sale holds
    // the unique tallyClientOrderId key. Wait on it as long as a claim waits, then answer 409.
    const orderRepository = this.connection.getRepository(ctx, Order);
    await orderRepository.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
    try {
      await orderRepository.save(order);
    } catch (error) {
      throw transientKind(error) === 'lock' ? new TransientCommandError(command.id, 'lock', error) : error;
    }
    await orderRepository.query('SET LOCAL lock_timeout = DEFAULT');
    const requested = new Map<string, { variant: ProductVariant; quantity: number }>();
    for (const line of payload.lines) {
      // A race after the pre-claim check: the variant was disabled or removed meanwhile.
      const variant = await this.findVariant(ctx, line.variantId);
      if (!variant) throw new BusinessRejection('unknown_variant', `Variant ${line.variantId} is missing or disabled`);
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
        // Review 13: enough payment, so look for a configuration cause first; else an unlisted ErrorResult (transient).
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
    // The take-back is the one compensating write (the amendment). It runs in a savepoint of its own:
    // if it fails, the sale stays committed, the claim stays as needs_admin, and an admin resolves it.
    let compensation: { error: unknown } | undefined;
    if (topUps.length) {
      try {
        await this.connection.withTransaction(ctx, async takeBackCtx => {
          for (const topUp of topUps) await this.adjustStock(takeBackCtx, topUp.id, location.id, -topUp.quantity);
        });
      } catch (error) {
        compensation = { error };
      }
    }
    const warnings: CommandWarning[] = topUps.map(({ variantId, quantity }) => ({ code: 'insufficient_stock', variantId, quantity }));
    const result: OrderCreateResult = {
      id: command.id, status: 'applied',
      serverRefs: { orderId: this.encodeId(order.id), displayId: order.code, totalMinor: order.totalWithTax },
      ...(warnings.length ? { warnings } : {}),
      ...(totalWarnings.length ? { totalWarnings } : {}),
    };
    await this.connection.getRepository(ctx, TallyCommand).save({
      id: command.id, channelId: String(ctx.channelId), clientOrderId: payload.clientOrderId, fingerprint: commandFingerprint(command),
      status: compensation ? 'needs_admin' : 'applied', result: { ...result },
    });
    if (compensation) {
      const { error } = compensation;
      Logger.error(`order.create ${command.id} needs an admin: order ${result.serverRefs!.displayId} is recorded, but taking back `
        + `its stock top-up failed (${error instanceof Error ? error.message : String(error)})`, loggerCtx,
        error instanceof Error ? error.stack : undefined);
    }
    return { result, needsAdmin: !!compensation, compensationError: compensation?.error };
  }

  private async adjustStock(ctx: RequestContext, variantId: ID, stockLocationId: ID, change: number) {
    const level = await this.stockLevels.getStockLevel(ctx, variantId, stockLocationId);
    await this.stockMovements.adjustProductVariantStock(ctx, variantId, [
      { stockLocationId, stockOnHand: level.stockOnHand + change },
    ]);
  }
}
