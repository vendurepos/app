import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { rateLimitSource } from '../vendored/rate-limit-source';

/** The Nest token for the clock behind every expiry and window (`() => number`, ms); absent means `Date.now`. Tests override it. */
export const TALLY_DISPLAY_CLOCK = Symbol('TALLY_DISPLAY_CLOCK');
/** The Nest token for `TallyPosPlugin.init({ customerDisplay })`. */
export const TALLY_DISPLAY_OPTIONS = Symbol('TALLY_DISPLAY_OPTIONS');

/** One ICE server, in the shape `RTCPeerConnection` takes (ADR-085 d7). */
export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type CustomerDisplayOptions = {
  /** Passed through to `/info`: absent means the client's default STUN pair, `[]` LAN-only. Readable by whoever can reach `/info`. */
  iceServers?: IceServer[];
};

/** The seam's refusal codes (`DisplaySignallingErrorCode`) that a server sends, and `invalid_request` for malformed input. */
export type DisplayRefusalCode =
  'forbidden' | 'limit' | 'claim_refused' | 'collect_refused' | 'not_found' | 'token_refused' | 'too_large' | 'invalid_request';
const STATUS: Record<DisplayRefusalCode, number> = {
  forbidden: 403, limit: 429, claim_refused: 403, collect_refused: 403, not_found: 404, token_refused: 401, too_large: 413, invalid_request: 400,
};
// One fixed message per code: every claim refusal and every collect refusal reads the same, so a guesser learns nothing.
const MESSAGES: Record<DisplayRefusalCode, string> = {
  forbidden: 'This session may not pair a customer display', limit: 'This device already holds 5 unspent codes',
  claim_refused: 'The code was not accepted', collect_refused: 'The claim was not accepted', not_found: 'Unknown display or claim',
  token_refused: 'The display token was not accepted', too_large: 'The snapshot is over 204800 bytes', invalid_request: 'Invalid request',
};

/** Every refusal of a signalling route; the controller answers it as `{ code, message }` with its status. */
export class DisplayRefusal extends Error {
  readonly status: number;
  constructor(readonly code: DisplayRefusalCode, message = MESSAGES[code]) {
    super(message);
    this.status = STATUS[code];
  }
}

export type SignalMessage = { type: 'offer' | 'answer' | 'ice'; payload: string };
type Till = { channelId: string; deviceId: string };
type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, any>>>;

// The floor of ADR-085 d4–d6 and d8, as TallyUI's reference server has it.
const MINUTE = 60_000;
const CODE_TTL = 10 * MINUTE, MAX_UNSPENT = 5, SNAPSHOT_TTL = MINUTE;
export const SNAPSHOT_MAX_BYTES = 204_800;
const SOURCE_WINDOW = MINUTE, SOURCE_MAX = 10, STORE_WINDOW = 10 * MINUTE, STORE_MAX = 100;
const CONNECTED_MS = 30_000, UNSEEN_TTL = 30 * 24 * 60 * MINUTE;
const STORE_KEY = 'store';
// A random draw (a pairing code or a check code) is retried on collision at most this often; past it the call is
// refused as `limit` and its transaction rolls back, so a crowded code space never holds a request in a loop.
const MAX_DRAWS = 50;

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** 128 bits, base64url without padding: 22 characters. */
const newSecret = () => randomBytes(16).toString('base64url');
const newId = () => randomBytes(16).toString('hex');
/** `digits` uniform random decimal digits from the CSPRNG. */
const randomDigits = (digits: number) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');
const at = (ms: number) => new Date(ms);
const iso = (date: Date) => date.toISOString();
const refuse = (code: DisplayRefusalCode) => new DisplayRefusal(code);

// Lazy pruning (V7): every call first deletes what has expired, in one statement. A display's snapshot and both
// inboxes go with it by ON DELETE CASCADE. A window row a claim holds is skipped, never waited on; a later call prunes it.
const PRUNE = `WITH codes AS (DELETE FROM "tally_display_code" WHERE "expiresAt" <= $1),
  pending AS (DELETE FROM "tally_display_pending" WHERE "expiresAt" <= $1),
  snapshots AS (DELETE FROM "tally_display_snapshot" WHERE "postedAt" <= $2),
  windows AS (DELETE FROM "tally_display_claim_window" WHERE "key" IN (SELECT "key" FROM "tally_display_claim_window"
    WHERE "expiresAt" <= $1 FOR UPDATE SKIP LOCKED))
  DELETE FROM "tally_display" WHERE COALESCE("lastSeenAt", "confirmedAt") <= $3`;

/**
 * The customer-display signalling seam (TallyUI ADR-085 d2, U7) on Postgres. Till-side calls see only their own
 * channel's rows; display-side calls find their row by a secret's or a token's hash alone. Each spend, collect and
 * failure count is one conditional statement, so concurrent server instances never both win one.
 */
@Injectable()
export class DisplaySignallingService {
  private readonly clock: () => number;

  constructor(
    private readonly connection: TransactionalConnection,
    @Optional() @Inject(TALLY_DISPLAY_CLOCK) clock?: () => number,
    @Optional() @Inject(TALLY_DISPLAY_OPTIONS) private readonly options: CustomerDisplayOptions = {},
  ) {
    this.clock = clock ?? Date.now;
  }

  /** `customerDisplay` of `GET /tally/v1/info` (ADR-085 d7, d8). */
  advertisement(): { v: 1; snapshot: 1; iceServers?: IceServer[] } {
    return { v: 1, snapshot: 1, ...(this.options.iceServers ? { iceServers: this.options.iceServers } : {}) };
  }

  async mint(ctx: RequestContext, deviceId: string): Promise<{ code: string; expiresAt: string }> {
    const now = await this.prune();
    const till = this.till(ctx, deviceId);
    return this.transaction(async query => {
      // One device's mints run one at a time, so the unspent count and the insert cannot interleave.
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tally-display-mint:${till.channelId}:${till.deviceId}`]);
      const [{ unspent }] = await query(`SELECT count(*)::int AS unspent FROM "tally_display_code"
        WHERE "channelId" = $1 AND "deviceId" = $2 AND NOT "spent" AND "expiresAt" > $3`, [till.channelId, till.deviceId, at(now)]);
      if (unspent >= MAX_UNSPENT) throw refuse('limit');
      const expiresAt = at(now + CODE_TTL);
      for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
        const code = randomDigits(6);
        const inserted = await query(`INSERT INTO "tally_display_code" ("code", "channelId", "deviceId", "expiresAt") VALUES ($1, $2, $3, $4)
          ON CONFLICT ("code") DO NOTHING RETURNING "code"`, [code, till.channelId, till.deviceId, expiresAt]);
        if (inserted.length) return { code, expiresAt: iso(expiresAt) };
      }
      throw refuse('limit');
    });
  }

  async pending(ctx: RequestContext, deviceId: string) {
    await this.prune();
    const till = this.till(ctx, deviceId);
    const rows = await this.query(`SELECT "id", "displayName", "checkCode", "expiresAt" FROM "tally_display_pending"
      WHERE "channelId" = $1 AND "deviceId" = $2 ORDER BY "expiresAt", "id"`, [till.channelId, till.deviceId]);
    return rows.map(row => ({ claimId: row.id, displayName: row.displayName, checkCode: row.checkCode, expiresAt: iso(row.expiresAt) }));
  }

  /** Confirms a claim: the display's row, owned by this device and cashier, waits for its first collect. A moving display keeps its id. */
  async confirm(ctx: RequestContext, deviceId: string, claimId: string): Promise<void> {
    const now = await this.prune();
    const till = this.till(ctx, deviceId);
    const cashierId = ctx.session?.user?.identifier ?? String(ctx.activeUserId);
    await this.transaction(async query => {
      const [entry] = await query(`DELETE FROM "tally_display_pending" WHERE "id" = $1 AND "channelId" = $2 AND "deviceId" = $3
        AND "expiresAt" > $4 RETURNING "secretHash", "displayName", "movingDisplayId"`, [claimId, till.channelId, till.deviceId, at(now)]);
      if (!entry) throw refuse('not_found');
      // The old row goes, and its token hash, snapshot and inboxes with it, in this same step.
      const [moved] = entry.movingDisplayId === null ? []
        : await query('DELETE FROM "tally_display" WHERE "id" = $1 RETURNING "id"', [entry.movingDisplayId]);
      await query(`INSERT INTO "tally_display" ("id", "channelId", "deviceId", "name", "cashierId", "confirmedAt", "secretHash")
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [moved?.id ?? newId(), till.channelId, till.deviceId, entry.displayName, cashierId, at(now), entry.secretHash]);
    });
  }

  async decline(ctx: RequestContext, deviceId: string, claimId: string): Promise<void> {
    await this.prune();
    const till = this.till(ctx, deviceId);
    const deleted = await this.query(`DELETE FROM "tally_display_pending" WHERE "id" = $1 AND "channelId" = $2 AND "deviceId" = $3
      RETURNING "id"`, [claimId, till.channelId, till.deviceId]);
    if (!deleted.length) throw refuse('not_found');
  }

  async list(ctx: RequestContext, deviceId: string) {
    const now = await this.prune();
    const till = this.till(ctx, deviceId);
    const rows = await this.query(`SELECT "id", "name", "cashierId", "lastSeenAt" FROM "tally_display"
      WHERE "channelId" = $1 AND "deviceId" = $2 ORDER BY "confirmedAt", "id"`, [till.channelId, till.deviceId]);
    return rows.map(row => ({
      displayId: row.id as string, name: row.name as string, cashierId: row.cashierId as string,
      lastSeenAt: row.lastSeenAt === null ? null : iso(row.lastSeenAt),
      connected: row.lastSeenAt !== null && now - (row.lastSeenAt as Date).getTime() <= CONNECTED_MS,
    }));
  }

  async forget(ctx: RequestContext, deviceId: string, displayId: string): Promise<void> {
    await this.prune();
    const till = this.till(ctx, deviceId);
    const deleted = await this.query(`DELETE FROM "tally_display" WHERE "id" = $1 AND "channelId" = $2 AND "deviceId" = $3
      RETURNING "id"`, [displayId, till.channelId, till.deviceId]);
    if (!deleted.length) throw refuse('not_found');
  }

  async sendSignal(ctx: RequestContext, deviceId: string, displayId: string, message: SignalMessage): Promise<void> {
    await this.prune();
    const till = this.till(ctx, deviceId);
    await this.transaction(async query => {
      await this.owned(query, till, displayId);
      await query('INSERT INTO "tally_display_signal" ("displayId", "toTill", "type", "payload") VALUES ($1, false, $2, $3)',
        [displayId, message.type, message.payload]);
    });
  }

  /** Drains this device's inbox: each message once, in send order, only from displays it owns now. */
  async receiveSignals(ctx: RequestContext, deviceId: string): Promise<Array<SignalMessage & { displayId: string }>> {
    await this.prune();
    const till = this.till(ctx, deviceId);
    const rows = await this.query(`DELETE FROM "tally_display_signal" AS s USING "tally_display" AS d
      WHERE s."displayId" = d."id" AND s."toTill" AND d."channelId" = $1 AND d."deviceId" = $2
      RETURNING s."seq", s."displayId", s."type", s."payload"`, [till.channelId, till.deviceId]);
    return rows.sort((a, b) => a.seq - b.seq).map(row => ({ type: row.type, payload: row.payload, displayId: row.displayId }));
  }

  /** Keeps `body` as the display's only snapshot; one over 204 800 UTF-8 bytes of JSON is refused and the old one stays. */
  async postSnapshot(ctx: RequestContext, deviceId: string, displayId: string, body: unknown): Promise<void> {
    const now = await this.prune();
    const till = this.till(ctx, deviceId);
    await this.transaction(async query => {
      await this.owned(query, till, displayId);
      const text = JSON.stringify(body) ?? 'null';
      if (Buffer.byteLength(text, 'utf8') > SNAPSHOT_MAX_BYTES) throw refuse('too_large');
      await query(`INSERT INTO "tally_display_snapshot" ("displayId", "body", "postedAt") VALUES ($1, $2, $3)
        ON CONFLICT ("displayId") DO UPDATE SET "body" = EXCLUDED."body", "postedAt" = EXCLUDED."postedAt"`, [displayId, text, at(now)]);
    });
  }

  /**
   * Claims a live code: spends it and records a pending pairing with a fresh check code, in one transaction. A source
   * or the store over its failed-claim limit is refused and spends nothing; a claim naming no live code is counted.
   */
  async claim(source: string, request: { code: string; displayName: string; token?: string }): Promise<{ claimSecret: string; checkCode: string }> {
    const now = await this.prune();
    const sourceKey = `source:${rateLimitSource(source)}`;
    const claimSecret = newSecret();
    const claimed = await this.transaction(async query => {
      // Claims run one at a time across every instance: the limit check, the spend and the failure count are one step.
      await query(`SELECT pg_advisory_xact_lock(hashtext('tally-display-claim'))`);
      const limited = await query(`SELECT 1 FROM "tally_display_claim_window" WHERE "expiresAt" > $1
        AND (("key" = $2 AND "failures" >= $3) OR ("key" = $4 AND "failures" >= $5))`, [at(now), sourceKey, SOURCE_MAX, STORE_KEY, STORE_MAX]);
      if (limited.length) return 'limited';
      const [code] = await query(`UPDATE "tally_display_code" SET "spent" = true WHERE "code" = $1 AND NOT "spent" AND "expiresAt" > $2
        RETURNING "channelId", "deviceId", "expiresAt"`, [request.code, at(now)]);
      if (!code) {
        await this.countFailure(query, sourceKey, now);
        return 'failed';
      }
      const [moving] = request.token === undefined ? []
        : await query('SELECT "id" FROM "tally_display" WHERE "tokenHash" = $1', [sha256Hex(request.token)]);
      // The unique index keeps check codes apart; a taken one is drawn again, up to MAX_DRAWS times.
      for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
        const checkCode = randomDigits(4);
        const inserted = await query(`INSERT INTO "tally_display_pending" ("id", "channelId", "deviceId", "secretHash", "displayName",
          "checkCode", "expiresAt", "movingDisplayId") VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ("checkCode") DO NOTHING RETURNING "id"`,
        [newId(), code.channelId, code.deviceId, sha256Hex(claimSecret), request.displayName, checkCode, code.expiresAt, moving?.id ?? null]);
        if (inserted.length) return { claimSecret, checkCode };
      }
      throw refuse('limit');
    });
    if (typeof claimed === 'string') throw refuse('claim_refused');
    return claimed;
  }

  /** Pending: the check code. After the confirm, the first collect makes the token, so only its hash is ever stored. */
  async collect(claimSecret: string): Promise<{ status: 'pending'; checkCode: string } | { status: 'paired'; displayId: string; token: string }> {
    await this.prune();
    const secretHash = sha256Hex(claimSecret);
    const [waiting] = await this.query('SELECT "checkCode" FROM "tally_display_pending" WHERE "secretHash" = $1', [secretHash]);
    if (waiting) return { status: 'pending', checkCode: waiting.checkCode };
    const token = newSecret();
    const [row] = await this.query(`UPDATE "tally_display" SET "secretHash" = NULL, "tokenHash" = $2
      WHERE "secretHash" = $1 AND "tokenHash" IS NULL RETURNING "id"`, [secretHash, sha256Hex(token)]);
    if (!row) throw refuse('collect_refused');
    return { status: 'paired', displayId: row.id, token };
  }

  async displaySendSignal(token: string, message: SignalMessage): Promise<void> {
    await this.byToken(token, (query, displayId) => query(
      'INSERT INTO "tally_display_signal" ("displayId", "toTill", "type", "payload") VALUES ($1, true, $2, $3)', [displayId, message.type, message.payload]));
  }

  async displayReceiveSignals(token: string): Promise<SignalMessage[]> {
    const rows = await this.byToken(token, (query, displayId) => query(`DELETE FROM "tally_display_signal" WHERE "displayId" = $1 AND NOT "toTill"
      RETURNING "seq", "type", "payload"`, [displayId]));
    return rows.sort((a, b) => a.seq - b.seq).map(row => ({ type: row.type, payload: row.payload }));
  }

  async readSnapshot(token: string): Promise<unknown> {
    const [held] = await this.byToken(token, (query, displayId) => query('SELECT "body" FROM "tally_display_snapshot" WHERE "displayId" = $1', [displayId]));
    return held ? JSON.parse(held.body) as unknown : null;
  }

  /** Deletes whatever has expired and gives the time the call runs at. */
  private async prune(): Promise<number> {
    const now = this.clock();
    await this.query(PRUNE, [at(now), at(now - SNAPSHOT_TTL), at(now - UNSEEN_TTL)]);
    return now;
  }

  private till(ctx: RequestContext, deviceId: string): Till {
    return { channelId: String(ctx.channelId), deviceId };
  }

  /** Holds the till's own display row until the transaction ends, so a forget cannot strand what it writes; `not_found` otherwise. */
  private async owned(query: Query, till: Till, displayId: string): Promise<void> {
    const rows = await query(`SELECT "id" FROM "tally_display" WHERE "id" = $1 AND "channelId" = $2 AND "deviceId" = $3 FOR KEY SHARE`,
      [displayId, till.channelId, till.deviceId]);
    if (!rows.length) throw refuse('not_found');
  }

  /** Runs `work` on the display the token names, marking it seen; the row stays locked until `work` is done. `token_refused` otherwise. */
  private async byToken<T>(token: string, work: (query: Query, displayId: string) => Promise<T>): Promise<T> {
    const now = await this.prune();
    return this.transaction(async query => {
      const [row] = await query('UPDATE "tally_display" SET "lastSeenAt" = $2 WHERE "tokenHash" = $1 RETURNING "id"', [sha256Hex(token), at(now)]);
      if (!row) throw refuse('token_refused');
      return work(query, row.id);
    });
  }

  /** Counts a failed claim in its source's window and the store-wide one, each opened by its first failure: one statement. */
  private async countFailure(query: Query, sourceKey: string, now: number): Promise<void> {
    await query(`INSERT INTO "tally_display_claim_window" AS w ("key", "failures", "expiresAt") VALUES ($1, 1, $3), ($2, 1, $4)
      ON CONFLICT ("key") DO UPDATE SET
        "failures" = CASE WHEN w."expiresAt" <= $5 THEN 1 ELSE w."failures" + 1 END,
        "expiresAt" = CASE WHEN w."expiresAt" <= $5 THEN EXCLUDED."expiresAt" ELSE w."expiresAt" END`,
    [sourceKey, STORE_KEY, at(now + SOURCE_WINDOW), at(now + STORE_WINDOW), at(now)]);
  }

  /** Rows of one statement, outside any transaction. */
  private query: Query = (sql, params) => this.transaction(query => query(sql, params));

  private async transaction<T>(work: (query: Query) => Promise<T>): Promise<T> {
    return this.connection.rawConnection.transaction((manager: EntityManager) =>
      work(async (sql, params) => (await manager.queryRunner!.query(sql, params, true)).records));
  }
}
