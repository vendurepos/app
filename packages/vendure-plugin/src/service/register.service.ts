import { Injectable } from '@nestjs/common';
import { Order, RequestContext, TransactionalConnection } from '@vendure/core';
import { In, IsNull, Not } from 'typeorm';
import type { FindOptionsWhere, ObjectType } from 'typeorm';
import {
  TallyRegister, TallyRegisterClosure, TallyRegisterMovement, TallyRegisterSession, TallyRegisterSessionAlias, TallyRegisterSessionStatus,
} from '../entities/register.entities';
import { TallyCommand } from '../entities/tally-command.entity';
import type {
  CommandResult, RegisterClosureSubmitPayload, RegisterCommandEnvelope, RegisterCommandResult, RegisterCommandType,
  RegisterMovementRecordPayload, RegisterMovementVoidPayload, RegisterSessionOpenPayload, RegisterSessionSupersededData, RegisterSessionTransitionPayload,
} from '../vendored/core-commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { deriveSessionFigures, deriveVariance } from '../vendored/register-figures';
import type { RegisterConflictCode } from '../vendored/register-outcome';
import { registerPayloadErrors } from '../vendored/register-payload-shape';
import { REGISTER_VERSIONS } from './constants';
import { TransientCommandError, transientKind } from './errors';
import {
  CLAIM_LOCK_TIMEOUT, CREATED_AT_SKEW_MS, RECIPE_LOCK_TIMEOUT, TEST_HOOKS_ENV, clientTimeErrors, nulPath,
} from './order-create.service';
import { registerStrictErrors } from './strict-shape';

// ADR 0003: the two-int advisory key (this, hashtext of the channel and register) serialises a register's commands
// across tills and instances. Apart from StoreSetupService's 0x7a11 and the customer lock's 0x7a12.
const REGISTER_LOCK_NAMESPACE = 0x7a13;

// Each type's client-time payload fields, in the order of its table in TallyUI's field-kinds.md.
const CLIENT_TIMES: Record<RegisterCommandType, string[]> = {
  'register.session.open': ['openedAt'],
  'register.session.transition': ['at'],
  'register.movement.record': ['createdAt'],
  'register.movement.void': ['createdAt'],
  'register.closure.submit': ['openedAt', 'closedAt'],
};
export const REGISTER_TYPES = Object.keys(CLIENT_TIMES) as RegisterCommandType[];

export type RegisterResult = CommandResult;
export type RegisterEnvelope = RegisterCommandEnvelope<Record<string, unknown>>;
type Status = 'open' | 'counting' | 'closed' | 'superseded';

const refuse = (id: string, code: string, message: string, data?: Record<string, unknown>): RegisterResult =>
  ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });

/** A state-dependent refusal found after the claim (ADR-068 d5): the transaction, claim included, rolls back unstored. */
class Unstored extends Error {
  constructor(readonly result: RegisterResult) {
    super(result.error!.message);
  }
}

/**
 * TallyUI's five register commands at contract versions 1 and 2 (ADR-078 adds the open's resume and take-over), each in its own transaction, in
 * order.create's step order: shape, replay read, strict fields and client time, claim, the register's lock, the
 * state checks, the writes and the stored result.
 */
@Injectable()
export class RegisterService {
  /** Test seam: runs after a command's writes, before its commit, only while VENDUREPOS_PLUGIN_TEST_HOOKS is '1'. */
  testHooks: { afterWrites?: (commandId: string) => Promise<void> } = {};

  constructor(private connection: TransactionalConnection) {}

  async apply(ctx: RequestContext, command: RegisterEnvelope, options: { requestTimeMs?: number } = {}): Promise<RegisterResult> {
    // 1. Shape and version, before any database access.
    const invalid = this.shapeRefusal(command);
    if (invalid) return invalid;
    const { id, type } = command;
    const payload = command.payload as { sessionId: string; registerId?: string } & Record<string, unknown>;
    let claimed = false;
    try {
      // 2. The replay read: a committed id answers as recorded.
      const existing = await this.connection.getRepository(ctx, TallyCommand).findOneBy({ id });
      if (existing) return this.replayAnswer(ctx, command, existing);
      // 3. Unknown fields and map keys (ADR-070 d1), then the client-time stage (field-kinds.md): unstored.
      const strict = registerStrictErrors(command as unknown as Record<string, unknown>, type, command.version);
      if (strict.length) return refuse(id, 'invalid_payload', strict.join('; '));
      const times = clientTimeErrors([['createdAt', command.createdAt], ...CLIENT_TIMES[type].map(
        (field): [string, unknown] => [`payload.${field}`, payload[field]])], (options.requestTimeMs ?? Date.now()) + CREATED_AT_SKEW_MS);
      if (times.length) return refuse(id, 'invalid_payload', times.slice(0, 10).join('; '));
      // 4. The resolved session. Sessions and aliases are write-once, so an unknown one, or a closure naming another register, is refused
      // here, unstored and without a lock (ADR-068 d5), and a known one's register never changes.
      // An alias names its session (ADR-078 d2).
      const session = type === 'register.session.open' ? undefined
        : await this.resolveSession(ctx, payload.sessionId);
      if (type !== 'register.session.open' && !session) return refuse(id, 'invalid_payload', `sessionId: unknown session ${payload.sessionId}`);
      if (type === 'register.closure.submit' && session!.registerId !== payload.registerId) {
        return refuse(id, 'invalid_payload', `registerId: expected the session's register ${session!.registerId}`);
      }
      return await this.connection.withTransaction(ctx, async tx => {
        // 5. The claim, 6. the register's lock, taken before any state read that decides the command.
        const concurrent = await this.claim(tx, command);
        if (concurrent) return concurrent;
        claimed = true;
        await this.connection.getRepository(tx, TallyCommand).query('SELECT pg_advisory_xact_lock($1, hashtext($2))',
          [REGISTER_LOCK_NAMESPACE, JSON.stringify([String(tx.channelId), session?.registerId ?? payload.registerId])]);
        // 7. The state checks, the writes and the stored result; a register_* conflict is stored (ADR-068 d5).
        const result = await this.handle(tx, command, session);
        if (process.env[TEST_HOOKS_ENV] === '1') await this.testHooks.afterWrites?.(id);
        await this.connection.getRepository(tx, TallyCommand).update(id, { status: result.status, result: { ...result } });
        return result;
      });
    } catch (error) {
      if (error instanceof Unstored) return error.result;
      // As order.create: a wait on another request's claim is 409, every later wait a 503.
      const kind = transientKind(error);
      throw new TransientCommandError(id, kind === 'lock' && claimed ? 'timeout' : kind ?? 'unclassified', error);
    }
  }

  private shapeRefusal(command: RegisterEnvelope): RegisterResult | undefined {
    const nul = nulPath(command, '');
    if (nul) return refuse(command.id, 'invalid_payload', `${nul}: must not contain U+0000`);
    // ADR-068 d5 and core's precheckCommand: the message and data name this server's own list.
    if (!REGISTER_VERSIONS.includes(command.version)) {
      return refuse(command.id, 'unsupported_version',
        `register version ${command.version} is not supported; this server supports ${REGISTER_VERSIONS.join(', ')}`,
        { register: Math.max(...REGISTER_VERSIONS) });
    }
    const errors = registerPayloadErrors(command.type, command.payload);
    return errors.length ? refuse(command.id, 'invalid_payload', errors.join('; ')) : undefined;
  }

  private replayAnswer(ctx: RequestContext, command: RegisterEnvelope, existing: TallyCommand): RegisterResult {
    if (existing.channelId !== String(ctx.channelId)) {
      return refuse(command.id, 'idempotency_mismatch', 'Command id was already used in another channel', { reason: 'command_in_other_channel' });
    }
    if (existing.fingerprint !== commandFingerprint(command as never)) {
      return refuse(command.id, 'idempotency_mismatch', 'Command id was already used with a different payload');
    }
    // ADR-068 d5: the result recorded at apply, never the current state.
    return { ...existing.result as unknown as RegisterResult, status: existing.status === 'rejected' ? 'rejected' : 'duplicate' };
  }

  // order.create's claim (ADR 0002 §2), with no clientOrderId.
  private async claim(tx: RequestContext, command: RegisterEnvelope): Promise<RegisterResult | undefined> {
    const repository = this.connection.getRepository(tx, TallyCommand);
    const runner = repository.manager.queryRunner!;
    const table = repository.metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
    await runner.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
    const rows = await runner.query(`INSERT INTO ${table} ("id", "channelId", "fingerprint", "status") VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (id) DO NOTHING RETURNING id`, [command.id, String(tx.channelId), commandFingerprint(command as never)]);
    await runner.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
    return rows.length ? undefined : this.replayAnswer(tx, command, await repository.findOneByOrFail({ id: command.id }));
  }

  private async handle(tx: RequestContext, command: RegisterEnvelope, session?: TallyRegisterSession): Promise<RegisterResult> {
    const channelId = String(tx.channelId);
    const repo = <T extends object>(entity: ObjectType<T>) => this.connection.getRepository(tx, entity);
    const applied = (register: RegisterCommandResult): RegisterResult => ({ id: command.id, status: 'applied', register });
    const conflict = (code: RegisterConflictCode, message: string, data?: Record<string, unknown>) => refuse(command.id, code, message, data);
    const unstored = (message: string) => new Unstored(refuse(command.id, 'invalid_payload', message));
    const commandId = command.id;

    if (command.type === 'register.session.open') {
      const p = command.payload as unknown as RegisterSessionOpenPayload;
      const live = await this.openSessionOf(tx, p.registerId);
      if (command.version >= 2) {
        const recorded = await this.resolveSession(tx, p.sessionId);
        if (recorded && (await this.sessionState(tx, recorded)).status === 'superseded') return this.supersededRefusal(tx, commandId, recorded);
      }
      if (command.version === 1 && live && p.sessionId === live.id && live.deviceId === command.deviceId) {
        const { status } = await this.sessionState(tx, live);
        return applied({ session: await this.liveSession(tx, live, status) });
      }
      if (command.version >= 2 && live && live.deviceId === command.deviceId) {
        const recorded = await this.resolveSession(tx, p.sessionId);
        if (recorded && recorded.id !== live.id) throw unstored(`sessionId: session ${p.sessionId} is already recorded`);
        if (!recorded) await repo(TallyRegisterSessionAlias).insert({ channelId, id: p.sessionId, sessionId: live.id, commandId });
        const { status } = await this.sessionState(tx, live);
        return applied({ session: { ...await this.liveSession(tx, live, status), openedAt: live.openedAt, openingFloatMinor: live.countedFloatMinor },
          ...(p.sessionId === live.id ? {} : { resumed: { fromSessionId: p.sessionId } }) });
      }
      const takeover = command.version >= 2 && live && p.supersedes !== undefined && (await this.resolveSession(tx, p.supersedes))?.id === live.id;
      if (live && !takeover) {
        const data = command.version === 1 ? { sessionId: live.id } : {
          sessionId: live.id, registerId: live.registerId, openedAt: live.openedAt, status: (await this.sessionState(tx, live)).status,
          ...(live.openedBy === null ? {} : { openedBy: live.openedBy }),
          ...(live.deviceId === null ? {} : { deviceId: live.deviceId }), ...(live.deviceName === null ? {} : { deviceName: live.deviceName }),
        };
        return conflict('register_session_already_open', `Register ${p.registerId} already has session ${live.id} open`, data);
      }
      if (await this.resolveSession(tx, p.sessionId)) throw unstored(`sessionId: session ${p.sessionId} is already recorded`);
      if (takeover) await repo(TallyRegisterSessionStatus).insert({ channelId, sessionId: live.id, status: 'superseded', at: p.openedAt,
        counted: null, closedBy: null, approvedBy: null, commandId });
      // ADR-068 d8: an unknown register id creates the register.
      await repo(TallyRegister).createQueryBuilder().insert().values({ channelId, id: p.registerId }).orIgnore().execute();
      const opened = repo(TallyRegisterSession).create({
        channelId, id: p.sessionId, registerId: p.registerId, storeKey: p.storeKey ?? null, businessDay: p.businessDay ?? null,
        openedAt: p.openedAt, openedBy: p.openedBy ?? null, expectedFloatMinor: p.expectedFloatMinor ?? null,
        countedFloatMinor: p.countedFloatMinor, openingVarianceMinor: p.openingVarianceMinor ?? null, commandId,
        deviceId: command.deviceId, deviceName: p.deviceName?.trim() ?? null, supersedes: takeover ? live.id : null,
        openVersion: command.version,
      });
      await repo(TallyRegisterSession).insert(opened);
      return applied({ session: await this.liveSession(tx, opened, 'open'), ...(takeover ? { superseded: {
        sessionId: live.id, openedAt: live.openedAt,
        ...(live.deviceId === null ? {} : { deviceId: live.deviceId }), ...(live.deviceName === null ? {} : { deviceName: live.deviceName }),
      } } : {}) });
    }

    const { status, closed } = await this.sessionState(tx, session!);
    if (status === 'superseded') {
      // TallyUI sends later commands at v1; follow what the session's till understands (TallyUI/tallyui#515).
      if (command.version >= 2 || (session!.openVersion ?? 1) >= 2) return this.supersededRefusal(tx, commandId, session!);
      return conflict('register_session_closed', `Session ${session!.id} is closed`);
    }
    if (command.type === 'register.session.transition') {
      const p = command.payload as unknown as RegisterSessionTransitionPayload;
      // ADR-068 d5a: a snapshot; the same status is an applied no-op, and nothing leaves closed.
      if (closed && p.status !== 'closed') return conflict('register_session_closed', `Session ${session!.id} is closed`);
      if (p.status !== status) {
        await repo(TallyRegisterSessionStatus).insert({ channelId, sessionId: session!.id, status: p.status, at: p.at,
          counted: p.counted ?? null, closedBy: p.closedBy ?? null, approvedBy: p.approvedBy ?? null, commandId });
      }
      return applied({ session: await this.liveSession(tx, session!, p.status) });
    }

    if (command.type === 'register.closure.submit') {
      const p = command.payload as unknown as RegisterClosureSubmitPayload;
      const existing = await repo(TallyRegisterClosure).findOne({ where: [{ channelId, sessionId: session!.id }, { channelId, id: p.closureId }] });
      if (existing) return conflict('register_closure_exists', `Session ${existing.sessionId} has closure ${existing.id}`, { closureId: existing.id });
      const counters = await this.counters(tx, session!.registerId);
      if (p.number !== counters.lastClosureNumber + 1) {
        return conflict('register_closure_number_invalid', `Closure number ${p.number} is not ${counters.lastClosureNumber + 1}`, { counters });
      }
      // ADR-068 d13.2: the float, the received orders in orderIds and the movements in movementIds; a void excludes its
      // target only if the void is in movementIds, as on the till's Z (TallyUI session-store.ts writeClosure).
      const orders = p.orderIds.length ? await this.receivedOrders(tx, { tallyClientOrderId: In(p.orderIds) }) : [];
      const movements = (await repo(TallyRegisterMovement).findBy({ channelId, sessionId: session!.id }))
        .filter(row => p.movementIds.includes(row.id));
      const { expected } = deriveSessionFigures({ countedFloatMinor: session!.countedFloatMinor, orders, movements });
      const variance = deriveVariance(p.counted, expected);
      await repo(TallyRegisterClosure).insert({
        channelId, id: p.closureId, sessionId: session!.id, registerId: p.registerId, number: p.number, businessDay: p.businessDay ?? null,
        openedAt: p.openedAt, closedAt: p.closedAt, closedBy: p.closedBy ?? null, approvedBy: p.approvedBy ?? null,
        tillExpected: p.tillExpected, counted: p.counted, periodSalesTotalMinor: p.periodSalesTotalMinor,
        periodRefundsTotalMinor: p.periodRefundsTotalMinor, perpetualSalesTotalMinor: p.perpetualSalesTotalMinor,
        perpetualRefundsTotalMinor: p.perpetualRefundsTotalMinor, unsyncedCount: p.unsyncedCount, unsyncedTotalMinor: p.unsyncedTotalMinor,
        softwareVersion: p.softwareVersion, orderIds: p.orderIds, movementIds: p.movementIds, expected, variance, commandId,
      });
      return applied({
        closure: { serverClosureId: p.closureId, number: p.number, expected, variance },
        counters: await this.counters(tx, session!.registerId),
      });
    }

    // A movement or a void (ADR-068 d4): on a session neither closed nor with its closure submitted.
    const p = command.payload as unknown as RegisterMovementRecordPayload & RegisterMovementVoidPayload;
    if (closed) return conflict('register_session_closed', `Session ${session!.id} is closed`);
    if (await repo(TallyRegisterMovement).existsBy({ channelId, id: p.movementId })) throw unstored(`movementId: movement ${p.movementId} is already recorded`);
    if (command.type === 'register.movement.void') {
      // A void names a movement of its own session, once; a missing target is unstored (d5), as is a second void.
      const target = await repo(TallyRegisterMovement).findOneBy({ channelId, sessionId: session!.id, id: p.voids });
      if (!target || target.type === 'void') throw unstored(`voids: no movement ${p.voids} in session ${session!.id}`);
      if (await repo(TallyRegisterMovement).existsBy({ channelId, voids: p.voids })) throw unstored(`voids: movement ${p.voids} is already voided`);
    }
    const isVoid = command.type === 'register.movement.void';
    await repo(TallyRegisterMovement).insert({
      channelId, id: p.movementId, sessionId: session!.id, type: isVoid ? 'void' : p.type, amountMinor: isVoid ? 0 : p.amountMinor,
      reason: isVoid ? null : p.reason, voids: isVoid ? p.voids : null, createdAt: p.createdAt, createdBy: p.createdBy ?? null, commandId,
    });
    return applied({ session: await this.liveSession(tx, session!, status) });
  }

  private async supersededRefusal(tx: RequestContext, commandId: string, session: TallyRegisterSession): Promise<RegisterResult> {
    const channelId = String(tx.channelId);
    const repo = <T extends object>(entity: ObjectType<T>) => this.connection.getRepository(tx, entity);
    const conflict = (code: RegisterConflictCode, message: string, data?: Record<string, unknown>) => refuse(commandId, code, message, data);
    const superseded = await repo(TallyRegisterSessionStatus).findOneByOrFail({ channelId, sessionId: session.id, status: 'superseded' });
    const successor = await repo(TallyRegisterSession).findOneByOrFail({ channelId, supersedes: session.id });
    const data = {
      sessionId: session.id, supersededAt: superseded.at, newSessionId: successor.id,
      ...(successor.openedBy === null ? {} : { supersededBy: successor.openedBy }),
      ...(successor.deviceId === null ? {} : { deviceId: successor.deviceId }),
      ...(successor.deviceName === null ? {} : { deviceName: successor.deviceName }),
    } satisfies RegisterSessionSupersededData;
    return conflict('register_session_superseded', `Session ${session.id} was taken over by session ${successor.id}`, data);
  }

  /** The register's live session, if any: no closed or superseded status and no closure. At most one, under the lock. */
  private async openSessionOf(tx: RequestContext, registerId: string): Promise<TallyRegisterSession | undefined> {
    const repository = this.connection.getRepository(tx, TallyRegisterSession);
    const table = (entity: ObjectType<object>) => {
      const { tablePath } = this.connection.getRepository(tx, entity).metadata;
      return tablePath.split('.').map(part => repository.manager.connection.driver.escape(part)).join('.');
    };
    return await repository.createQueryBuilder('s').where(`s."channelId" = :channelId AND s."registerId" = :registerId
      AND NOT EXISTS (SELECT 1 FROM ${table(TallyRegisterSessionStatus)} t
        WHERE t."channelId" = s."channelId" AND t."sessionId" = s.id AND t.status IN ('closed', 'superseded'))
      AND NOT EXISTS (SELECT 1 FROM ${table(TallyRegisterClosure)} c WHERE c."channelId" = s."channelId" AND c."sessionId" = s.id)
      `, { channelId: String(tx.channelId), registerId }).orderBy('s.receivedAt').limit(1).getOne() ?? undefined;
  }

  private async resolveSession(tx: RequestContext, id: string): Promise<TallyRegisterSession | undefined> {
    const channelId = String(tx.channelId);
    const sessions = this.connection.getRepository(tx, TallyRegisterSession);
    const session = await sessions.findOneBy({ channelId, id });
    if (session) return session;
    const alias = await this.connection.getRepository(tx, TallyRegisterSessionAlias).findOneBy({ channelId, id });
    return alias ? await sessions.findOneBy({ channelId, id: alias.sessionId }) ?? undefined : undefined;
  }

  /** The last applied status, `open` before any; `closed` also once the session's closure is submitted. */
  private async sessionState(tx: RequestContext, session: TallyRegisterSession): Promise<{ status: Status; closed: boolean }> {
    const where = { channelId: session.channelId, sessionId: session.id };
    const last = await this.connection.getRepository(tx, TallyRegisterSessionStatus).findOne({ where, order: { seq: 'DESC' } });
    const status = last?.status ?? 'open';
    return { status, closed: status === 'closed' || await this.connection.getRepository(tx, TallyRegisterClosure).existsBy(where) };
  }

  /** Derived from the register's closures under its lock, never stored (ADR 0003); refunds stay 0 (ADR-068 d9). */
  private async counters(tx: RequestContext, registerId: string) {
    const last = await this.connection.getRepository(tx, TallyRegisterClosure).findOne({
      where: { channelId: String(tx.channelId), registerId }, order: { number: 'DESC' },
    });
    return { lastClosureNumber: last?.number ?? 0, perpetualSalesTotalMinor: last?.perpetualSalesTotalMinor ?? 0, perpetualRefundsTotalMinor: 0 };
  }

  /** ADR-068 d13.1: the live figure counts every received order in the channel carrying the session's id.
   * ADR-078 d2: orders carrying any of the session's aliases count too. */
  private async liveSession(tx: RequestContext, session: TallyRegisterSession, status: Status) {
    const aliases = await this.connection.getRepository(tx, TallyRegisterSessionAlias).findBy({ channelId: session.channelId, sessionId: session.id });
    const orders = await this.receivedOrders(tx, { tallySessionId: In([session.id, ...aliases.map(alias => alias.id)]) });
    const movements = await this.connection.getRepository(tx, TallyRegisterMovement).findBy({ channelId: session.channelId, sessionId: session.id });
    return { id: session.id, status, ...deriveSessionFigures({ countedFloatMinor: session.countedFloatMinor, orders, movements }) };
  }

  /**
   * Orders order.create recorded in full in this channel (tallyPayments is written at the recipe's end), with the POS
   * payments it recorded. A tallyRejected order counts as never placed (ADR-068 d13.6 amendment).
   */
  private async receivedOrders(tx: RequestContext, customFields: FindOptionsWhere<Order['customFields']>) {
    const orders = await this.connection.getRepository(tx, Order).find({
      select: { id: true, customFields: { tallyPayments: true, tallyRejected: true } },
      where: { channels: { id: tx.channelId }, customFields: { ...customFields, tallyPayments: Not(IsNull()) } },
    });
    return orders.filter(order => !order.customFields.tallyRejected).map(order => {
      try {
        return { payments: JSON.parse(order.customFields.tallyPayments!) };
      } catch {
        return { payments: [] }; // deriveSessionFigures skips a malformed record too
      }
    });
  }
}
