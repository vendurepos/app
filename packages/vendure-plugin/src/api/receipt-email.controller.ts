import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { Allow, Ctx, EventBus, OrderService, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { TallyReceiptEmailEvent } from '../events/receipt-email.event';
import { WALK_IN_EMAIL } from '../service/constants';

/** Whether `TallyPosPlugin.init({ receiptEmail: true })` was given. */
export const TALLY_RECEIPT_EMAIL = Symbol('TALLY_RECEIPT_EMAIL');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // and at most 254 characters, RFC 5321's longest path
/** 12.1a: a cashier's explicit receipt email, not ADR 0002's automatic confirmation. It writes nothing; each request sends one. */
@Controller('tally/v1')
export class TallyReceiptEmailController {
  constructor(private orders: OrderService, private eventBus: EventBus, @Inject(TALLY_RECEIPT_EMAIL) private enabled: boolean) {}

  @Post('orders/:code/receipt-email')
  @HttpCode(202)
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async send(@Ctx() ctx: RequestContext, @Param('code') code: string, @Body() body: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const refuse = (status: number, refusal: string, message: string) => (res.status(status), { code: refusal, message });
    if (!this.enabled) return refuse(404, 'receipt_email_disabled', 'The plugin was set up without receiptEmail');
    const input = (body ?? {}) as { emailAddress?: unknown }, given = input.emailAddress;
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'emailAddress')
      || (given !== undefined && (typeof given !== 'string' || given.length > 254 || !EMAIL.test(given.trim())))) {
      return refuse(400, 'invalid_payload', 'Expected a body of { emailAddress? }, an email address');
    }
    const order = await this.orders.findOneByCode(ctx, code);
    if (!order) return refuse(404, 'order_not_found', `No order ${code} in this channel`);
    if (!order.customFields.tallyClientOrderId || order.customFields.tallyRejected) return refuse(409, 'not_till_order', 'Not a till sale');
    const recipient = typeof given === 'string' ? given.trim() : order.customer?.emailAddress;
    if (!recipient || recipient === WALK_IN_EMAIL) return refuse(422, 'no_recipient', 'The order has no customer email; give emailAddress');
    await this.eventBus.publish(new TallyReceiptEmailEvent(ctx, order, recipient));
    return { queued: true, emailAddress: recipient };
  }
}
