/**
 * The shared ledger helpers of the plugin's commands (ADR 0002 §2): one copy for order.create, the register
 * commands and order.refund.
 */
import type { RequestContext, TransactionalConnection } from '@vendure/core';
import type { ObjectLiteral, Repository } from 'typeorm';
import { TallyCommand } from '../entities/tally-command.entity';
import type { AnyCommandEnvelope, CommandResult } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { TransientCommandError, transientKind } from './errors';

// ADR 0002 §2: a second claim for the same id waits this long on the uncommitted row.
export const CLAIM_LOCK_TIMEOUT = '5s';
// Front desk ruling 7: every wait after the claim is bounded; a timeout is a 503 and the till retries.
export const RECIPE_LOCK_TIMEOUT = '10s';
// ADR-038 #220: a client time no later than the request's clock plus this skew, which absorbs a till whose clock
// runs ahead; the lower bound is CREATED_AT_FLOOR, and an offline till's old sales from 2020 on still apply.
export const CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
// Front desk ruling 2026-09-30, the same bound in both backends: no POS sale predates the product, and a 1970 clock is a broken till.
const CREATED_AT_FLOOR = '2020-01-01T00:00:00Z';
const CREATED_AT_FLOOR_MS = Date.parse(CREATED_AT_FLOOR);

/** The path of the first string holding U+0000 in an envelope, or undefined. */
export function nulPath(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') return value.includes('\u0000') ? path : undefined;
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = nulPath(item, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}

// Front desk, 2026-09-30: RFC 3339 with Z or an offset, strict form.
function clientTimeMs(value: unknown): number | undefined {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return undefined;
  const zone = match[8];
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) return undefined;
  const fractionMs = Number((match[7]?.slice(1, 4) ?? '').padEnd(3, '0'));
  const offsetMs = zone === 'Z' ? 0 : (zone[0] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
  return Date.UTC(year, month - 1, day, hour, minute, second) + fractionMs - offsetMs;
}

/** TallyUI #337 (b65c8ff): one message per client-time field outside the bounds, the bound compared exactly, shown to the second. */
export const clientTimeErrors = (fields: [path: string, value: unknown][], upperBoundMs: number) => {
  const upper = new Date(upperBoundMs).toISOString().replace(/\.\d+Z$/, 'Z');
  return fields.flatMap(([path, value]) => {
    const time = clientTimeMs(value);
    if (time === undefined) return [`${path} must be an RFC 3339 time with Z or an offset`];
    return time >= CREATED_AT_FLOOR_MS && time <= upperBoundMs ? []
      : [`${path} must be a time from ${CREATED_AT_FLOOR} to ${upper}`];
  });
};

/** A command's refusal. */
export const refuse = (id: string, code: string, message: string, data?: Record<string, unknown>): CommandResult & { status: 'rejected' } =>
  ({ id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } });

/** Review: Postgres text cannot hold U+0000, so a string carrying it is refused before any database access. */
export function nulRefusal(command: { id: string }) {
  const nul = nulPath(command, '');
  return nul ? refuse(command.id, 'invalid_payload', `${nul}: must not contain U+0000`) : undefined;
}

/** ADR-068 d5 and core's precheckCommand: the message and data name this server's own list. */
export function versionRefusal(id: string, version: number, label: string, key: string, versions: readonly number[]) {
  return versions.includes(version) ? undefined : refuse(id, 'unsupported_version',
    `${label} version ${version} is not supported; this server supports ${versions.join(', ')}`, { [key]: Math.max(...versions) });
}

/** The escaped table path of a repository's entity. A query runner's connection is its manager's: the same DataSource. */
export function ledgerTablePath(repository: Repository<ObjectLiteral>): string {
  return repository.metadata.tablePath.split('.').map(part => repository.manager.connection.driver.escape(part)).join('.');
}

/** A refusal found after the claim: the transaction, claim included, rolls back unstored (ADR-068 d5). */
export class Unstored extends Error {
  constructor(readonly result: CommandResult) {
    super(result.error!.message);
  }
}

/** As order.create: a wait on another request's claim is 409, every later wait a 503. */
export function transientAfterClaim(id: string, error: unknown, claimed: boolean): TransientCommandError {
  const kind = transientKind(error);
  return new TransientCommandError(id, kind === 'lock' && claimed ? 'timeout' : kind ?? 'unclassified', error);
}

/** ADR-068 d5 and N6: a recorded command id's answer, the same for every command. */
export function replayAnswer(ctx: RequestContext, command: AnyCommandEnvelope, existing: TallyCommand): CommandResult {
  const fingerprint = commandFingerprint(command);
  // N6: another channel's command id never replays that channel's answer.
  if (existing.channelId !== String(ctx.channelId)) {
    return refuse(command.id, 'idempotency_mismatch', 'Command id was already used in another channel',
      { reason: 'command_in_other_channel' });
  }
  if (existing.fingerprint !== fingerprint) {
    return refuse(command.id, 'idempotency_mismatch', 'Command id was already used with a different payload');
  }
  // The amendment: a row awaiting an admin answers 409 in_progress, never duplicate or rejected.
  if (existing.status === 'needs_admin') throw new TransientCommandError(command.id, 'needs_admin', undefined);
  // ADR-068 d5: the result recorded at apply, never the current state.
  const stored = existing.result as unknown as CommandResult;
  return { ...stored, status: existing.status === 'rejected' ? 'rejected' : 'duplicate' };
}

/** ADR-038 #220 step 2: the explicit replay read, a plain SELECT before any claim. */
export async function replayRead(connection: TransactionalConnection, ctx: RequestContext, command: AnyCommandEnvelope): Promise<CommandResult | undefined> {
  const existing = await connection.getRepository(ctx, TallyCommand).findOneBy({ id: command.id });
  return existing ? replayAnswer(ctx, command, existing) : undefined;
}

// ADR 0002 §2 "The claim": Postgres-only. A second claim for the id waits on the uncommitted row.
// order.create's claim carries its clientOrderId; a register or refund claim has none.
export async function claim(
  connection: TransactionalConnection, tx: RequestContext, command: AnyCommandEnvelope, clientOrderId?: string,
): Promise<CommandResult | undefined> {
  const repository = connection.getRepository(tx, TallyCommand);
  const runner = repository.manager.queryRunner!;
  const table = ledgerTablePath(repository);
  const fingerprint = commandFingerprint(command);
  await runner.query(`SET LOCAL lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
  const rows = clientOrderId !== undefined
    ? await runner.query(
      `INSERT INTO ${table} ("id", "channelId", "clientOrderId", "fingerprint", "status") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [command.id, String(tx.channelId), clientOrderId, fingerprint, 'pending'],
    )
    : await runner.query(`INSERT INTO ${table} ("id", "channelId", "fingerprint", "status") VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (id) DO NOTHING RETURNING id`, [command.id, String(tx.channelId), fingerprint]);
  // Only the claim waits 5 s for a 409; every later wait is bounded too (ruling 7), and its timeout is a 503.
  await runner.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
  if (rows.length) return undefined;
  // The safety net for a concurrent request: the other one committed while this one waited.
  return replayAnswer(tx, command, await repository.findOneByOrFail({ id: command.id }));
}

/** order.refund's platform_error refusal, stored as rejected; a row already there answers as recorded. The caller owns the transaction. */
export async function storeRejection(
  connection: TransactionalConnection, tx: RequestContext, command: AnyCommandEnvelope, result: CommandResult,
): Promise<CommandResult> {
  const repository = connection.getRepository(tx, TallyCommand);
  const runner = repository.manager.queryRunner!;
  const table = ledgerTablePath(repository);
  const rows = await runner.query(`INSERT INTO ${table} ("id", "channelId", "fingerprint", "status", "result")
    VALUES ($1, $2, $3, 'rejected', $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
  [command.id, String(tx.channelId), commandFingerprint(command), JSON.stringify(result)]);
  return rows.length ? result : replayAnswer(tx, command, await repository.findOneByOrFail({ id: command.id }));
}
