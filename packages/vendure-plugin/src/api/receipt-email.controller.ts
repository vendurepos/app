import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { Allow, Ctx, EventBus, OrderService, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { TallyReceiptEmailEvent } from '../events/receipt-email.event';
import { WALK_IN_EMAIL } from '../service/constants';

/** `TallyPosPlugin.init({ receiptEmail })`: false, or the route's caps with the defaults filled in. */
export const TALLY_RECEIPT_EMAIL = Symbol('TALLY_RECEIPT_EMAIL');
export type ReceiptEmailCaps = false | { perOrder: number; perUserPerMinute: number };
const PER_ORDER = 3; // successful sends per order: a resend or two after a typo, not a mail cannon
const PER_USER_PER_MINUTE = 20; // requests per user per minute, refusals included: a busy till, not an order-code probe
export const receiptEmailCaps = (option?: boolean | { perOrder?: number; perUserPerMinute?: number }): ReceiptEmailCaps => {
  const given = option === true ? {} : option;
  return !!given && { perOrder: given.perOrder ?? PER_ORDER, perUserPerMinute: given.perUserPerMinute ?? PER_USER_PER_MINUTE };
};
// One plain ASCII address (no list, quote, space or header character), and at most 254 characters, RFC 5321's longest path.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** 12.1a: a cashier's explicit receipt email, not ADR 0002's automatic confirmation. It writes nothing; each request sends one. */
@Controller('tally/v1')
export class TallyReceiptEmailController {
  private readonly recent = new Map<string, number[]>(); // in memory on this singleton, so both caps are per server process
  private readonly sent = new Map<string, number>();
  constructor(private orders: OrderService, private eventBus: EventBus, @Inject(TALLY_RECEIPT_EMAIL) private caps: ReceiptEmailCaps) {}

  @Post('orders/:code/receipt-email')
  @HttpCode(202)
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async send(@Ctx() ctx: RequestContext, @Param('code') code: string, @Body() body: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const refuse = (status: number, refusal: string, message: string) => (res.status(status), { code: refusal, message });
    if (!this.caps) return refuse(404, 'receipt_email_disabled', 'The plugin was set up without receiptEmail');
    const user = String(ctx.activeUserId), now = Date.now(), recent = (this.recent.get(user) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.caps.perUserPerMinute) return refuse(429, 'rate_limited', `At most ${this.caps.perUserPerMinute} requests a minute`);
    this.recent.set(user, [...recent, now]);
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
    const key = String(order.id), sent = this.sent.get(key) ?? 0;
    if (sent >= this.caps.perOrder) return refuse(429, 'order_send_limit', `At most ${this.caps.perOrder} receipt emails per order`);
    await this.eventBus.publish(new TallyReceiptEmailEvent(ctx, order, recipient));
    this.sent.set(key, (this.sent.get(key) ?? 0) + 1);
    return { queued: true, emailAddress: recipient };
  }
}
