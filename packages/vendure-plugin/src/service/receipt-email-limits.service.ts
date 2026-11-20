import { Inject, Injectable, Optional } from '@nestjs/common';
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import type { ReceiptEmailCaps } from '../api/receipt-email.controller';
import { TALLY_DISPLAY_CLOCK } from './display-signalling.service';

/** `TallyPosPlugin.init({ receiptEmail })`: false, or the route's caps with the defaults filled in. Defined here, not in the controller, so the two files import without a cycle. */
export const TALLY_RECEIPT_EMAIL = Symbol('TALLY_RECEIPT_EMAIL');
const DAY = 24 * 60 * 60_000; // the daily caps' window, opened by its first counted send: a fixed window, so no store time zone
const ORDER_WINDOW = 30 * DAY; // an order's window: a resend weeks later still passes, a mail cannon at one order does not
type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, any>>>;
export type ReceiptEmailLimit = { code: 'order_send_limit' | 'user_daily_limit' | 'channel_daily_limit'; cap: number; retryAt: Date };

/** #345: the per-order and daily caps, kept in `tally_receipt_email_window`, so they hold across restarts and server instances. */
@Injectable()
export class ReceiptEmailLimits {
  private readonly clock: () => number;

  constructor(
    private readonly connection: TransactionalConnection,
    // The route calls `reserve` only when it is on, so never with `false`.
    @Inject(TALLY_RECEIPT_EMAIL) private readonly caps: Exclude<ReceiptEmailCaps, false>,
    @Optional() @Inject(TALLY_DISPLAY_CLOCK) clock?: () => number,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Counts one send in its order's, user's and channel's windows; or, counting nothing, the first full cap and when every cap lets a send pass. */
  async reserve(ctx: RequestContext, orderId: ID): Promise<ReceiptEmailLimit | null> {
    const now = this.clock(), caps = this.caps;
    const keys = [
      { key: `order:${orderId}`, code: 'order_send_limit', cap: caps.perOrder },
      { key: `user:${ctx.activeUserId}`, code: 'user_daily_limit', cap: caps.perUserPerDay },
      { key: `channel:${ctx.channelId}`, code: 'channel_daily_limit', cap: caps.perChannelPerDay },
    ] as const;
    // READ COMMITTED on any database default: the lock holds only if the read takes its snapshot after the lock is granted.
    return this.connection.rawConnection.transaction('READ COMMITTED', async (manager: EntityManager) => {
      const query: Query = async (sql, params) => (await manager.queryRunner!.query(sql, params, true)).records;
      // One lock for the whole server, as the user key spans channels: every instance's sends run one at a time.
      await query(`SELECT pg_advisory_xact_lock(hashtext('tally-receipt-email'))`);
      await query('DELETE FROM "tally_receipt_email_window" WHERE "expiresAt" <= $1', [new Date(now)]);
      const rows = await query('SELECT "key", "sends", "expiresAt" FROM "tally_receipt_email_window" WHERE "key" = ANY($1)', [keys.map(k => k.key)]);
      const full = keys.flatMap(k => rows.filter(row => row.key === k.key && row.sends >= k.cap).map(row => ({ ...k, expiresAt: row.expiresAt as Date })));
      if (full.length) return { code: full[0].code, cap: full[0].cap, retryAt: new Date(Math.max(...full.map(k => k.expiresAt.getTime()))) };
      await query(`INSERT INTO "tally_receipt_email_window" AS w ("key", "sends", "expiresAt") VALUES ($1, 1, $4), ($2, 1, $5), ($3, 1, $5)
        ON CONFLICT ("key") DO UPDATE SET "sends" = w."sends" + 1`, [...keys.map(k => k.key), new Date(now + ORDER_WINDOW), new Date(now + DAY)]);
      return null;
    });
  }
}
