import { Injectable } from '@nestjs/common';
import {
  Allocation, ConfigService, Customer, CustomerService, ID, Logger, Order, OrderCalculator, OrderLine, OrderService, PaymentMethod, PaymentService,
  ProductVariant, ProductVariantService, RequestContext, ShippingLine, ShippingMethod, StockLevel, StockLevelService,
  StockLocationService, StockMovementService, Surcharge, TaxRate, TransactionalConnection,
  idsAreEqual, isGraphQlErrorResult, manualFulfillmentHandler, normalizeEmailAddress,
} from '@vendure/core';
import type { CurrencyCode } from '@vendure/core';
import { In, IsNull } from 'typeorm';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, isTallyRoute, markTallyRoute, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingChecker,
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
  BusinessRejection, PLATFORM_ERROR_CODE, StoreConfigurationRefusal, TransientCommandError, internalErrorFor, loggerCtx, pluginBug,
  transientKind, unwrap,
} from './errors';
import { StoreSetupService } from './store-setup.service';
import { roundHalfAwayFromZero } from './rounding';
import { CUSTOMER_ID_MAX, MAX_INT4, maxMoneyMinor, valueRangeErrors } from './value-ranges';

/** Additive warnings (S1 finding 5) until TallyUI's CommandWarning carries them (2.2.0). */
export type TotalWarning =
  | { code: 'total_mismatch'; expectedMinor: number; serverMinor: number; bridgeMinor: number }
  | { code: 'tax_rate_mismatch'; ratePpm: number; expectedMinor: number; serverMinor: number };

/** A customerId treated as absent (the fallback chain); the till ignores the code as unknown. */
export type CustomerIgnored = { code: 'customer_ignored'; customerId: string; reason: 'too_long' | 'unknown' };

export type OrderCreateResult = Omit<CommandResult, 'warnings'>
  & { warnings?: Array<CommandWarning | CustomerIgnored>; totalWarnings?: TotalWarning[] };

/** Where a sale's stock top-up was made, kept on the ledger row for an admin's take-back. */
export type TopUp = { variantId: string; stockLocationId: string; quantity: number };

export type PricingStage = 'addItemToOrder' | 'setShippingMethod' | 'surchargeSave' | 'finalPass' | 'payments';

export const WALK_IN_EMAIL = 'walk-in@vendurepos.invalid';
// ADR 0002 §2: a second claim for the same id waits this long on the uncommitted row.
const CLAIM_LOCK_TIMEOUT = '5s';
// Front desk ruling 7: every wait after the claim is bounded; a timeout is a 503 and the till retries.
const RECIPE_LOCK_TIMEOUT = '10s';
// Front desk ruling 6: the wait for the sale's stock rows; a timeout is a 503 (transient timeout).
const STOCK_LOCK_TIMEOUT = '5s';
// ADR-038 #220: a createdAt no later than now plus this skew, which absorbs a till whose clock runs
// ahead; there is no lower bound, since an offline till sends old sales. Later or unparseable: invalid_payload.
const CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
/** The environment variable that enables the test hooks; production never sets it. */
export const TEST_HOOKS_ENV = 'VENDUREPOS_PLUGIN_TEST_HOOKS';
// platformCode of an admin's `rejected` resolution of a needs_admin row.
const ADMIN_REJECTED = 'TALLY_ADMIN_REJECTED';

type TestHook = 'beforeStoringRejection' | 'afterCommit' | 'beforeFirstWrite' | 'insideRepair';
type SaleOutcome = { result: OrderCreateResult; needsAdmin?: boolean; compensationError?: unknown };
/** A clientOrderId collision after the recipe's first event: roll everything back and run the command again. */
class Rerun extends Error {}
class RepairStoreSetup extends Error {}
/** An unstored refusal after the claim (store-wide setup, TallyUI #219): the claim rolls back, so the same id applies later. */
class SetupRefusal extends Error {
  constructor(readonly result: OrderCreateResult) {
    super(result.error!.code);
  }
}
/** What the recipe has written so far, for an admin when it cannot finish. */
type SaleProgress = { written?: boolean; order?: Order; topUps: TopUp[] };

/** The path of the first string holding U+0000 in an envelope, or undefined. */
function nulPath(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') return value.includes('\u0000') ? path : undefined;
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = nulPath(item, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}

const createdAtError = (value: unknown, path: string) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return time <= Date.now() + CREATED_AT_SKEW_MS ? []
    : [`${path}: expected a time no later than one day from now`];
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
    private storeSetup: StoreSetupService,
  ) {}

  /**
   * Runs one order.create command in its own transaction (ADR 0002 §2). Returns the command's
   * result; throws TransientCommandError for every failure that may be retried (classification.ts),
   * and with kind `needs_admin` once part of a sale remains that the plugin cannot finish or undo.
   */
  async create(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>, options?: { repaired?: boolean }): Promise<OrderCreateResult> {
    // ADR-038 #220's step order. 1. Shape, NUL included, before any database access.
    const invalid = this.shapeRefusal(command);
    if (invalid) return invalid;
    const { payload } = command;
    let outcome: SaleOutcome;
    let commandCtx!: RequestContext;
    try {
      // 2. The replay read: a committed id answers as recorded, never entering the claim, whatever its values now.
      const replay = await this.replayRead(ctx, command);
      if (replay) return replay;
      // 3. The collision lookup: a sale already recorded is answered by the collision guard after the claim.
      const recorded = await this.recordedAnywhere(ctx, payload.clientOrderId);
      // 4. The value refusals (amounts, quantities, v3 fiscal figures, the future-only createdAt bound): unstored.
      const invalidValue = recorded ? undefined : this.valueRefusal(command);
      if (invalidValue) return invalidValue;
      // ADR 0002 "Currency": set before any line is added. A fresh context has no transaction.
      commandCtx = new RequestContext({
        req: ctx.req, apiType: ctx.apiType, channel: ctx.channel, session: ctx.session,
        languageCode: ctx.languageCode, currencyCode: payload.currency as CurrencyCode,
        isAuthorized: ctx.isAuthorized, authorizedAsOwnerOnly: ctx.authorizedAsOwnerOnly,
      });
      if (isTallyRoute(ctx)) markTallyRoute(commandCtx);
      outcome = await this.connection.withTransaction(commandCtx, async txCtx => {
        // 5. The claim (its conflict handling is the safety net for a concurrent request), and the collision guard.
        const concurrent = await this.claim(txCtx, command);
        if (concurrent) return { result: concurrent };
        const requeued = await this.requeueResult(txCtx, command);
        if (requeued) return { result: requeued };
        // The recorded sale vanished meanwhile (an admin rejection released it): start again as a new sale.
        if (recorded) throw new Rerun();
        // 6. The stored and unstored checks: nothing of the sale is written, no event fires.
        const refusal = await this.deterministicRefusal(txCtx, command);
        if (refusal) {
          await this.runTestHook('beforeStoringRejection', command.id);
          await this.connection.getRepository(txCtx, TallyCommand).update(command.id, { status: 'rejected', result: { ...refusal } });
          return { result: refusal };
        }
        // 7. The recipe.
        return await this.runSale(txCtx, command);
      });
    } catch (error) {
      // A collision after the recipe's first event: everything rolled back (its events with it), so start again.
      if (error instanceof Rerun) return this.create(ctx, command, options);
      if (error instanceof RepairStoreSetup) {
        if (options?.repaired) return storeConfiguration(command.id);
        try {
          await this.connection.withTransaction(commandCtx, async tx => {
            await this.storeSetup.ensureChannelSetup(tx);
            await this.runTestHook('insideRepair', command.id);
          });
        } catch (repairError) {
          const kind = transientKind(repairError);
          throw new TransientCommandError(command.id, kind === 'lock' ? 'timeout' : kind ?? 'unclassified', repairError);
        }
        return this.create(ctx, command, { repaired: true });
      }
      if (error instanceof SetupRefusal) return error.result;
      if (error instanceof StoreConfigurationRefusal) return error.message
        ? rejected(command.id, 'store_configuration', error.message) : storeConfiguration(command.id);
      if (error instanceof TransientCommandError) throw error;
      throw new TransientCommandError(command.id, transientKind(error) ?? 'unclassified', error);
    }
    if (outcome.needsAdmin) throw new TransientCommandError(command.id, 'needs_admin', outcome.compensationError);
    return outcome.result;
  }

  /**
   * Front desk re-ruling 3: the recipe publishes its first event at its first write (a new
   * customer's CustomerEvent in createOrUpdate, else createDraft's OrderEvent), and a committed
   * stored rejection would deliver it for an order that does not exist. So no error from the recipe
   * becomes a stored rejection: a race or any other failure rolls everything back (its events are
   * then dropped), a clientOrderId collision starts the command again, and a plugin bug with part of
   * the sale written is kept for an admin (needs_admin).
   */
  private async runSale(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<SaleOutcome> {
    const progress: SaleProgress = { topUps: [] };
    try {
      return await this.recipe(ctx, command, progress);
    } catch (error) {
      if (error instanceof TransientCommandError) throw error;
      const verdict = classify(error, this.clientOrderIdIndex());
      if (verdict.outcome === 'notStored') throw error;
      if (verdict.outcome === 'collision') throw new Rerun();
      if (verdict.outcome === 'needsAdmin' && !progress.written) {
        // TallyUI #219 R2: a plugin bug before the first write stores internal_error; nothing was written or emitted.
        const result = internalErrorFor(command.id, error);
        await this.connection.getRepository(ctx, TallyCommand).update(command.id, { status: 'rejected', result: { ...result } });
        return { result };
      }
      if (verdict.outcome === 'needsAdmin' && progress.order) return this.markNeedsAdmin(ctx, command, progress, error);
      // N5: after the claim, a lock timeout is a timeout, not another request's claim.
      const kind = verdict.outcome === 'transient' ? verdict.kind : 'unclassified';
      throw new TransientCommandError(command.id, kind === 'lock' ? 'timeout' : kind, error);
    }
  }

  /** Keeps a sale the plugin cannot finish or undo for an admin: the row is needs_admin, resends answer 409. */
  private async markNeedsAdmin(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>, progress: SaleProgress, error: unknown) {
    const order = progress.order!;
    const result: OrderCreateResult = { id: command.id, status: 'applied',
      serverRefs: { orderId: this.encodeId(order.id), displayId: order.code, totalMinor: order.totalWithTax } };
    await this.connection.getRepository(ctx, TallyCommand).update(command.id, {
      status: 'needs_admin', result: { ...result }, topUps: progress.topUps.length ? progress.topUps : null,
    });
    Logger.error(`order.create ${command.id} needs an admin: order ${order.code} is partly recorded `
      + `(${error instanceof Error ? error.message : String(error)})`, loggerCtx, error instanceof Error ? error.stack : undefined);
    return { result, needsAdmin: true, compensationError: error };
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
      // Either resolution takes back the top-up the failed take-back left, exactly where it was made
      // (the admin's channel may have another default location), in the resolution's transaction.
      if (row.topUps?.length) await this.lockStock(txCtx, [...new Set(row.topUps.map(topUp => topUp.variantId))]);
      for (const topUp of row.topUps ?? []) await this.adjustStock(txCtx, topUp.variantId, topUp.stockLocationId, -topUp.quantity);
      if (resolution === 'rejected') {
        // Rulings 4, N4 and re-ruling 1: a rejected row never keeps a live order. The top-up, the settled
        // POS payments, Vendure's cancellation (stock restored as it restores it) and releasing the
        // clientOrderId commit with the rejection, or none of them does.
        const refuse = (reason: string) => new Error(`Command ${commandId} is not rejected: ${reason}`);
        const orderId = this.decodeId(stored.serverRefs!.orderId)!;
        const order = await this.orders.findOne(txCtx, orderId);
        if (!order) {
          // The order exists but this context's channel does not see it: refuse, and the transaction changes nothing.
          if (await this.connection.getRepository(txCtx, Order).existsBy({ id: orderId })) {
            throw refuse(`the order is in channel ${row.channelId}; resolve from that channel`);
          }
          pluginBug(`Order ${orderId} of ${commandId} is missing`);
        }
        for (const payment of await this.orders.getOrderPayments(txCtx, orderId)) {
          if (payment.method !== TALLY_PAYMENT_METHOD_CODE || payment.state !== 'Settled') continue;
          const cancelledPayment = await this.payments.cancelPayment(txCtx, payment.id);
          if (isGraphQlErrorResult(cancelledPayment) || cancelledPayment.state !== 'Cancelled') {
            throw refuse(`payment ${payment.id} cannot be cancelled`);
          }
        }
        // Idempotent: an order an admin already cancelled is left as it is. Vendure refuses an empty line selection.
        const cancelled = order.state === 'Cancelled' ? order : order.lines.length
          ? await this.orders.cancelOrder(txCtx, { orderId, reason: note, cancelShipping: true })
          : await this.orders.transitionToState(txCtx, orderId, 'Cancelled');
        if (isGraphQlErrorResult(cancelled)) {
          throw refuse(`order ${stored.serverRefs!.displayId} cannot be cancelled (${cancelled.errorCode}: ${cancelled.message})`);
        }
        // Re-ruling 1: release the client id (the Retry's new sale takes it) and keep it, flagged, on the
        // cancelled order. Re-ruling 2: a tallyRejected order counts as never placed in any register figure.
        await this.connection.getRepository(txCtx, Order).update(orderId, { customFields: {
          tallyClientOrderId: null, tallyRejectedClientOrderId: row.clientOrderId, tallyRejected: true,
        } });
      }
      const result = resolution === 'applied' ? stored
        : rejected(commandId, PLATFORM_ERROR_CODE, `${ADMIN_REJECTED}: ${note}`, { platformCode: ADMIN_REJECTED, platformMessage: note });
      // Compare-and-set: only a row still awaiting an admin is resolved.
      const updated = await ledger.update({ id: commandId, status: 'needs_admin' }, { status: resolution, result: { ...result } });
      if (updated.affected !== 1) throw new Error(`Command ${commandId} was resolved meanwhile`);
      Logger.warn(`order.create ${commandId}: needs_admin resolved as ${resolution} (${note})`, loggerCtx);
      return result;
    });
  }

  /** Test seams (VP2): they run only while VENDUREPOS_PLUGIN_TEST_HOOKS is '1', which production never sets. */
  testHooks: Partial<Record<TestHook, (commandId: string) => Promise<void>>> = {};

  async runTestHook(name: TestHook, commandId: string) {
    if (process.env[TEST_HOOKS_ENV] === '1') await this.testHooks[name]?.(commandId);
  }

  // ADR-038 #220 step 1: shape and version refusals (U+0000, duplicate clientLineIds included), before any database access.
  private shapeRefusal(command: CommandEnvelope<OrderCreatePayload>): OrderCreateResult | undefined {
    const id = typeof command?.id === 'string' ? command.id : '';
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return rejected(id, 'invalid_payload', 'Expected command object');
    }
    // Review: Postgres text cannot hold U+0000, so a string carrying it is refused before any database access.
    const nul = nulPath(command, '');
    if (nul) return rejected(id, 'invalid_payload', `${nul}: must not contain U+0000`);
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
    // #12 review: a repeated clientLineId could merge order lines and meet ORDER_LIMIT_ERROR after the draft.
    const seen = new Set<string>();
    (Array.isArray(command.payload?.lines) ? command.payload.lines : []).forEach((line, index) => {
      const lineId = (line as { clientLineId?: unknown } | null)?.clientLineId;
      if (typeof lineId !== 'string') return;
      if (seen.has(lineId)) errors.push(`lines[${index}].clientLineId: expected no duplicate clientLineId`);
      seen.add(lineId);
    });
    return errors.length ? rejected(id, 'invalid_payload', errors.join('; ')) : undefined;
  }
  // ADR-038 #220 step 4: the payload's values, after the replay read and the collision lookup and before the claim:
  // an unstored invalid_payload (Front desk, matching precheckCommand).
  private valueRefusal(command: CommandEnvelope<OrderCreatePayload>): OrderCreateResult | undefined {
    const maxMoney = maxMoneyMinor(this.config.entityOptions.moneyStrategy?.moneyColumnOptions.type);
    const errors = valueRangeErrors(command.payload, maxMoney);
    // ADR-038 #220: createdAt has only an upper bound (an offline till sends old sales).
    errors.push(...createdAtError(command.createdAt, 'createdAt'), ...createdAtError(command.payload.createdAt, 'payload.createdAt'));
    if (!errors.length && command.version === 3) errors.push(...fiscalFiguresErrors(command.payload));
    return errors.length ? rejected(command.id, 'invalid_payload', errors.join('; ')) : undefined;
  }

  // ADR 0002 "Store configuration": the POS payment and shipping methods and a usable tax zone.
  private async setupState(ctx: RequestContext): Promise<'ok' | 'repairable' | 'refuse'> {
    const payment = await this.connection.getRepository(ctx, PaymentMethod).findOne({
      where: { code: TALLY_PAYMENT_METHOD_CODE, channels: { id: ctx.channelId } },
    });
    const shipping = await this.connection.getRepository(ctx, ShippingMethod).findOne({
      where: { code: TALLY_SHIPPING_METHOD_CODE, deletedAt: IsNull(), channels: { id: ctx.channelId } },
    });
    const zone = ctx.channel.defaultTaxZone;
    const rates = zone && await this.connection.getRepository(ctx, TaxRate).count({
      where: { zoneId: zone.id, enabled: true, customerGroup: IsNull() },
    });
    // Front desk ruling (A): the permanent-list configuration errors, found before any write. The
    // plugin's own checkers and handler accept every POS order; a replaced one or a missing manual handler would not.
    const checkers = (!payment || (payment.enabled && (!payment.checker || payment.checker.code === tallyPaymentChecker.code)
      && payment.handler.code === tallyPaymentHandler.code)) && (!shipping || shipping.checker.code === tallyShippingChecker.code)
      && this.config.shippingOptions.fulfillmentHandlers.some(handler => handler.code === manualFulfillmentHandler.code);
    if (!rates || !checkers) return 'refuse';
    return payment && shipping ? 'ok' : 'repairable';
  }

  /**
   * Checked after the claim and before the recipe writes anything, so no event fires: store-wide setup
   * (currency, configuration, order limits) rolls the claim back unstored; the state-dependent per-sale
   * facts (unknown_variant, underpaid) are stored on the claim. The recipe keeps the checks for races.
   */
  private async deterministicRefusal(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>) {
    const { lines, payments, totalMinor, currency } = command.payload;
    // TallyUI #219: store-wide setup is never stored; the caller rolls the claim back (SetupRefusal).
    if (!ctx.channel.availableCurrencyCodes.includes(currency as CurrencyCode)) {
      throw new SetupRefusal(rejected(command.id, 'unsupported_currency', `The channel does not offer ${currency}`));
    }
    const setup = await this.setupState(ctx);
    if (setup === 'repairable') throw new RepairStoreSetup();
    if (setup === 'refuse') throw new SetupRefusal(storeConfiguration(command.id));
    const { orderItemsLimit, orderLineItemsLimit } = this.config.orderOptions;
    const items = lines.reduce((sum, line) => sum + line.quantity, 0);
    // Vendure's OrderLimitError conditions; POS lines stay 1:1 with order lines. The limits are store-wide
    // setup (Front desk): not stored, so the same id applies once a limit is raised.
    if (items > orderItemsLimit || lines.some(line => line.quantity > orderLineItemsLimit)) {
      throw new SetupRefusal(rejected(command.id, 'store_configuration',
        `The sale exceeds orderOptions.orderItemsLimit ${orderItemsLimit} or orderLineItemsLimit ${orderLineItemsLimit}`));
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
    // B1: a disabled or deleted product makes addItemToOrder throw EntityNotFoundError, so it is refused here.
    const variant = id === undefined ? null : await this.connection.getRepository(ctx, ProductVariant).findOne({
      where: { id, deletedAt: IsNull(), channels: { id: ctx.channelId }, product: { enabled: true, deletedAt: IsNull() } },
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
    const { clientOrderId } = command.payload;
    const order = await this.existingOrder(ctx, clientOrderId);
    const ledger = this.connection.getRepository(ctx, TallyCommand);
    if (order) {
      // N2: Vendure also puts every order in the default channel, so the order's command row may be another channel's.
      const orderId = this.encodeId(order.id);
      const rows = await ledger.find({ where: { clientOrderId, status: In(['applied', 'needs_admin']) } });
      const source = rows.find(row => (row.result as OrderCreateResult | null)?.serverRefs?.orderId === orderId);
      // Unreachable by construction (an admin's rejection cancels the order and frees its clientOrderId): transient.
      if (!source) throw new TransientCommandError(command.id, 'unclassified', new Error(`Order ${orderId} has no applied command`));
      if (source.channelId === String(ctx.channelId)) {
        if (source.status === 'needs_admin') throw new TransientCommandError(command.id, 'needs_admin', undefined);
        const { id: _id, status: _status, ...stored } = source.result as unknown as OrderCreateResult;
        const result: OrderCreateResult = { id: command.id, status: 'applied', ...stored };
        await ledger.update(command.id, { status: 'applied', result: { ...result } });
        return result;
      }
    } else if (!await this.recordedAnywhere(ctx, clientOrderId)) {
      return undefined;
    }
    const mismatch = rejected(command.id, 'idempotency_mismatch', 'The clientOrderId is already recorded in another channel',
      { reason: 'client_order_in_other_channel' });
    await ledger.update(command.id, { status: 'rejected', result: { ...mismatch } });
    return mismatch;
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
    // Only the claim waits 5 s for a 409; every later wait is bounded too (ruling 7), and its timeout is a 503.
    await runner.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
    if (rows.length) return undefined;
    // The safety net for a concurrent request: the other one committed while this one waited.
    return this.replayAnswer(ctx, command, await repository.findOneByOrFail({ id: command.id }));
  }

  /** ADR-038 #220 step 2: the explicit replay read, a plain SELECT before any claim. */
  private async replayRead(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>) {
    const existing = await this.connection.getRepository(ctx, TallyCommand).findOneBy({ id: command.id });
    return existing ? this.replayAnswer(ctx, command, existing) : undefined;
  }

  private replayAnswer(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>, existing: TallyCommand): OrderCreateResult {
    const fingerprint = commandFingerprint(command);
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
  private async recipe(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>, progress: SaleProgress): Promise<SaleOutcome> {
    const payload = command.payload;
    // ADR 0002 "Customer": a customerId over its bound, or unknown here, is treated as absent, with a warning.
    const given = payload.customer?.customerId;
    const tooLong = !!given && given.length > CUSTOMER_ID_MAX;
    const customerId = given && !tooLong ? this.decodeId(given) : undefined;
    let customer = customerId !== undefined ? await this.customers.findOne(ctx, customerId) : undefined;
    const ignored: CustomerIgnored[] = given && !customer
      ? [{ code: 'customer_ignored', customerId: given.slice(0, CUSTOMER_ID_MAX), reason: tooLong ? 'too_long' : 'unknown' }] : [];
    await this.runTestHook('beforeFirstWrite', command.id);
    if (!customer) {
      // Review: createOrUpdate matches a customer of any channel and overwrites its names, so find it the
      // same way first (and add this channel, as createOrUpdate did); create only a missing one.
      const emailAddress = normalizeEmailAddress(payload.customer?.email || WALK_IN_EMAIL);
      const customers = this.connection.getRepository(ctx, Customer);
      customer = await customers.findOne({ where: { emailAddress, deletedAt: IsNull() }, relations: ['channels'] }) ?? undefined;
      progress.written = true; // The recipe's first write follows: nothing it raises from here is stored.
      if (!customer) {
        customer = unwrap(await this.customers.createOrUpdate(ctx, { emailAddress, firstName: '', lastName: '' }));
      } else if (!customer.channels.some(channel => idsAreEqual(channel.id, ctx.channelId))) {
        await customers.createQueryBuilder().relation('channels').of(customer).add(ctx.channelId);
      }
    }
    progress.written = true;
    // The recipe's first event is published here (a new customer's CustomerEvent comes just before it).
    let order = await this.orders.createDraft(ctx);
    progress.order = order;
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
    await orderRepository.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
    const requested = new Map<string, { variant: ProductVariant; quantity: number }>();
    for (const line of payload.lines) {
      // A race after the pre-claim check: the variant was disabled or removed meanwhile.
      const variant = await this.findVariant(ctx, line.variantId);
      if (!variant) throw new BusinessRejection('unknown_variant', `Variant ${line.variantId} is missing or disabled`);
      const entry = requested.get(line.variantId) ?? { variant, quantity: 0 };
      requested.set(line.variantId, { variant, quantity: entry.quantity + line.quantity });
    }
    // Ruling 5: Vendure's stock writes are absolute values from unlocked reads, so a concurrent sale of the variant
    // lost its update (VP3 investigation Q2). Outside the order-save try, so a lock timeout here is a 503.
    await this.lockStock(ctx, [...requested.values()].map(({ variant }) => variant.id));
    // ADR 0002 "Stock": top up a shortage before addItemToOrder, which would otherwise save the
    // line at the saleable quantity, and before ArrangingPayment, which checks saleable stock again.
    const topUps: TopUp[] = [];
    const stockWarnings: CommandWarning[] = [];
    for (const [variantId, { variant, quantity }] of requested) {
      const available = await this.stockLevels.getAvailableStock(ctx, variant.id);
      const physicalShort = Math.max(0, quantity - Math.max(0, available.stockOnHand - available.stockAllocated));
      if (physicalShort > 0) stockWarnings.push({ code: 'insufficient_stock', variantId, quantity: physicalShort });
      const topUp = Math.max(0, quantity - await this.variants.getSaleableStockLevel(ctx, variant));
      if (topUp === 0) continue;
      // A copied context keeps the probe's per-request stock cache out of the real allocation after the top-up.
      const plan = await this.stockLocations.getAllocationLocations(ctx.copy(),
        new OrderLine({ productVariantId: variant.id, productVariant: variant, quantity }), quantity);
      // Vendure creates a stock location at start and falls back to the oldest, so none at all is a bug, not a pre-check.
      const location = plan.reduce((sum, entry) => sum + entry.quantity, 0) >= quantity
        ? plan[0].location : (await this.stockLocations.defaultStockLocation(ctx)) ?? pluginBug('Vendure returned no default stock location');
      await this.adjustStock(ctx, variant.id, location.id, topUp);
      const entry = { variantId: String(variant.id), stockLocationId: String(location.id), quantity: topUp };
      topUps.push(entry);
      progress.topUps.push(entry);
      if (await this.variants.getSaleableStockLevel(ctx, variant) < quantity) throw new StoreConfigurationRefusal(
        `Variant ${variantId} cannot be made saleable in this channel (no stock location the StockLocationStrategy sells from)`);
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
      const orderLine = order.lines.find(item => item.customFields.tallyClientLineId === line.clientLineId) ?? pluginBug(`No order line for clientLineId ${line.clientLineId}`);
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
      const payment = unwrap(await this.payments.createPayment(ctx, order, amount, TALLY_PAYMENT_METHOD_CODE, { tender }));
      // N1: the payload covers the total (pre-claim), so any tally-pos payment not Settled is the store's
      // configuration (a replaced handler, a missing route mark), never underpaid.
      if (payment.state !== 'Settled') throw new StoreConfigurationRefusal();
      remaining -= amount;
    }
    order = await this.orders.findOne(ctx, order.id) ?? pluginBug(`Order ${order.id} vanished inside its own transaction`);
    progress.order = order;
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
        if (await this.setupState(ctx) !== 'ok') throw new StoreConfigurationRefusal();
      }
      order = unwrap(settled);
    }
    // Backstop for custom strategies: every POS line must be allocated in full, exactly once.
    for (const line of order.lines.filter(line => line.customFields.tallyClientLineId)) {
      const allocations = await this.connection.getRepository(ctx, Allocation).find({ where: { orderLine: { id: line.id } } });
      if (allocations.reduce((sum, entry) => sum + entry.quantity, 0) !== line.quantity) throw new StoreConfigurationRefusal(
        `Stock allocation for order line ${line.id} did not match its quantity`);
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
          for (const topUp of topUps) await this.adjustStock(takeBackCtx, topUp.variantId, topUp.stockLocationId, -topUp.quantity);
        });
      } catch (error) {
        compensation = { error };
      }
    }
    const warnings: Array<CommandWarning | CustomerIgnored> = [
      ...stockWarnings, ...ignored,
    ];
    const result: OrderCreateResult = {
      id: command.id, status: 'applied',
      serverRefs: { orderId: this.encodeId(order.id), displayId: order.code, totalMinor: order.totalWithTax },
      ...(warnings.length ? { warnings } : {}),
      ...(totalWarnings.length ? { totalWarnings } : {}),
    };
    await this.connection.getRepository(ctx, TallyCommand).save({
      id: command.id, channelId: String(ctx.channelId), clientOrderId: payload.clientOrderId, fingerprint: commandFingerprint(command),
      status: compensation ? 'needs_admin' : 'applied', result: { ...result }, topUps: progress.topUps.length ? progress.topUps : null,
    });
    if (compensation) {
      const { error } = compensation;
      Logger.error(`order.create ${command.id} needs an admin: order ${result.serverRefs!.displayId} is recorded, but taking back `
        + `its stock top-up failed (${error instanceof Error ? error.message : String(error)})`, loggerCtx,
        error instanceof Error ? error.stack : undefined);
    }
    return { result, needsAdmin: !!compensation, compensationError: compensation?.error };
  }

  // Locks every stock_level row of the sale's variants, in one order, so overlapping sales cannot deadlock on them.
  private async lockStock(ctx: RequestContext, ids: ID[]) {
    const levels = this.connection.getRepository(ctx, StockLevel);
    await levels.query(`SET LOCAL lock_timeout = '${STOCK_LOCK_TIMEOUT}'`);
    await levels.createQueryBuilder('level').select('level.id').where('level.productVariantId IN (:...ids)', { ids })
      .orderBy('level.productVariantId').addOrderBy('level.stockLocationId').setLock('pessimistic_write').getMany();
    await levels.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
  }

  private async adjustStock(ctx: RequestContext, variantId: ID, stockLocationId: ID, change: number) {
    // Read under the row lock: a no-op inside the recipe, the protection for resolveNeedsAdmin's take-back.
    await this.connection.getRepository(ctx, StockLevel).createQueryBuilder('level').select('level.id')
      .where({ productVariantId: variantId, stockLocationId }).setLock('pessimistic_write').getMany();
    const level = await this.stockLevels.getStockLevel(ctx, variantId, stockLocationId);
    await this.stockMovements.adjustProductVariantStock(ctx, variantId, [
      { stockLocationId, stockOnHand: level.stockOnHand + change },
    ]);
  }
}
