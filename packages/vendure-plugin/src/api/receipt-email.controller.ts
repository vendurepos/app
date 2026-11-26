import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { Allow, Ctx, EventBus, Logger, OrderService, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { TallyReceiptEmailEvent } from '../events/receipt-email.event';
import { WALK_IN_EMAIL } from '../service/constants';
import { loggerCtx } from '../service/errors';
import { ReceiptEmailLimits, TALLY_RECEIPT_EMAIL } from '../service/receipt-email-limits.service';

export { TALLY_RECEIPT_EMAIL };
export type ReceiptEmailCaps = false | { perOrder: number; perUserPerMinute: number; perUserPerDay: number; perChannelPerDay: number };
const PER_ORDER = 3; // successful sends per order in 30 days: a resend or two after a typo, not a mail cannon
const TRACKED = 10_000; // the most users the in-memory `recent` map holds
const PER_USER_PER_MINUTE = 20; // requests per user per minute, refusals included: a busy till, not an order-code probe
const PER_USER_PER_DAY = 500; // successful sends per user in 24 hours: a busy till can pass 200 in one shift
const PER_CHANNEL_PER_DAY = 1000; // successful sends per channel in 24 hours, from all its users and API keys together
export const receiptEmailCaps = (option?: boolean | { perOrder?: number; perUserPerMinute?: number; perUserPerDay?: number; perChannelPerDay?: number }): ReceiptEmailCaps => {
  const given = option === true ? {} : option;
  return !!given && { perOrder: given.perOrder ?? PER_ORDER, perUserPerMinute: given.perUserPerMinute ?? PER_USER_PER_MINUTE,
    perUserPerDay: given.perUserPerDay ?? PER_USER_PER_DAY, perChannelPerDay: given.perChannelPerDay ?? PER_CHANNEL_PER_DAY };
};
// One plain ASCII address (no list, quote, space or header character), and at most 254 characters, RFC 5321's longest path.
// No `=` or `?`, so no RFC 2047 encoded word, and an alphabetic top-level label, so no IP-shaped domain.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/^_`{|}~-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
/** 12.1a: a cashier's explicit receipt email, not ADR 0002's automatic confirmation. It changes no customer or order; each request sends one. */
@Controller('tally/v1')
export class TallyReceiptEmailController {
  private readonly recent = new Map<string, number[]>(); // in memory on this singleton, so only the per-minute cap is per server process
  constructor(private orders: OrderService, private eventBus: EventBus, @Inject(TALLY_RECEIPT_EMAIL) private caps: ReceiptEmailCaps,
    private limits: ReceiptEmailLimits) {}

  @Post('orders/:code/receipt-email')
  @HttpCode(202)
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async send(@Ctx() ctx: RequestContext, @Param('code') code: string, @Body() body: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const refuse = (status: number, refusal: string, message: string, extra?: { retryAt: string }) => (res.status(status), { code: refusal, message, ...extra });
    if (!this.caps) return refuse(404, 'receipt_email_disabled', 'The plugin was set up without receiptEmail');
    // It sends the order's receipt and can echo its customer's email, so Vendure's order-list read access too; the till preset holds it.
    if (!ctx.userHasAllPermissions([Permission.ReadOrder])) return refuse(403, 'forbidden', 'The receipt email needs ReadOrder as well');
    const user = String(ctx.activeUserId), now = Date.now(), recent = (this.recent.get(user) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.caps.perUserPerMinute) return refuse(429, 'rate_limited', `At most ${this.caps.perUserPerMinute} requests a minute`);
    this.recent.delete(user); // so the map runs from the least to the most recently let-through user
    this.recent.set(user, [...recent, now]);
    if (this.recent.size > TRACKED) this.recent.delete(this.recent.keys().next().value!); // a dropped user only loses its in-memory minute
    const input = (body ?? {}) as { emailAddress?: unknown }, given = input.emailAddress;
    const typed = typeof given === 'string' ? given.replace(/^ +| +$/g, '') : undefined; // spaces only, so a CR or LF is refused
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'emailAddress')
      || (given !== undefined && (typed === undefined || typed.length > 254 || !EMAIL.test(typed)))) {
      return refuse(400, 'invalid_payload', 'Expected a body of { emailAddress? }, an email address');
    }
    const order = await this.orders.findOneByCode(ctx, code);
    if (!order) return refuse(404, 'order_not_found', `No order ${code} in this channel`);
    if (!order.customFields.tallyClientOrderId || order.customFields.tallyRejected) return refuse(409, 'not_till_order', 'Not a till sale');
    const recipient = typed ?? order.customer?.emailAddress;
    if (!recipient || recipient === WALK_IN_EMAIL || !EMAIL.test(recipient)) return refuse(422, 'no_recipient', 'The order has no customer email; give emailAddress');
    // #345: counted before the send, so a failed publish errs towards fewer emails, never more.
    const limited = await this.limits.reserve(ctx, order.id);
    if (limited) {
      const option = { order_send_limit: 'perOrder', user_daily_limit: 'perUserPerDay', channel_daily_limit: 'perChannelPerDay' }[limited.code];
      if (!limited.retryAt) return refuse(429, limited.code, `The \`${option}\` cap is 0, so no receipt email can be sent`);
      const retryAt = limited.retryAt.toISOString(), who = { order_send_limit: 'This order already had', user_daily_limit: 'This user already sent',
        channel_daily_limit: 'This store already sent' }[limited.code], today = limited.code === 'order_send_limit' ? '' : ' today';
      return refuse(429, limited.code, `${who} ${limited.cap} receipt emails${today}; another can be sent after ${retryAt}`, { retryAt });
    }
    await this.eventBus.publish(new TallyReceiptEmailEvent(ctx, order, recipient));
    Logger.info(`Receipt email queued for order ${order.code} by user ${user}`, loggerCtx);
    return { queued: true, emailAddress: recipient };
  }
}
