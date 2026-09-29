import { Injectable } from '@nestjs/common';
import {
  ChannelService, Customer, CustomerService, LanguageCode, PaymentMethod, PaymentMethodService, RequestContext,
  ShippingMethod, ShippingMethodService, TransactionalConnection, idsAreEqual, manualFulfillmentHandler,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingCalculator, tallyShippingChecker,
} from '../config/strategies';
import { WALK_IN_EMAIL } from './constants';
import { unwrap } from './errors';

// Two-int advisory keys occupy a separate namespace from other plugins' single-bigint keys. The key (this, 0) is
// deliberately global, not per channel: the POS methods and the walk-in are rows shared by every channel.
const SETUP_LOCK_NAMESPACE = 0x7a11;

@Injectable()
export class StoreSetupService {
  constructor(
    private connection: TransactionalConnection,
    private channels: ChannelService,
    private shippingMethods: ShippingMethodService,
    private paymentMethods: PaymentMethodService,
    private customers: CustomerService,
  ) {}

  async ensureChannelSetup(ctx: RequestContext) {
    const shippingRepo = this.connection.getRepository(ctx, ShippingMethod);
    await shippingRepo.query("SET LOCAL lock_timeout = '5s'");
    await shippingRepo.query('SELECT pg_advisory_xact_lock($1, 0)', [SETUP_LOCK_NAMESPACE]);
    const shipping = await shippingRepo.findOne({
      where: { code: TALLY_SHIPPING_METHOD_CODE, deletedAt: IsNull() }, relations: ['channels'],
    });
    if (!shipping) {
      await this.shippingMethods.create(ctx, {
        code: TALLY_SHIPPING_METHOD_CODE, fulfillmentHandler: manualFulfillmentHandler.code,
        translations: [{ languageCode: LanguageCode.en, name: 'In-store collection', description: '' }],
        checker: { code: tallyShippingChecker.code, arguments: [] },
        calculator: { code: tallyShippingCalculator.code, arguments: [] },
      });
    } else if (!shipping.channels.some(channel => idsAreEqual(channel.id, ctx.channelId))) {
      await this.channels.assignToChannels(ctx, ShippingMethod, shipping.id, [ctx.channelId]);
    }
    const payment = await this.connection.getRepository(ctx, PaymentMethod).findOne({
      where: { code: TALLY_PAYMENT_METHOD_CODE }, relations: ['channels'],
    });
    const checker = { code: tallyPaymentChecker.code, arguments: [] };
    if (!payment) {
      await this.paymentMethods.create(ctx, {
        code: TALLY_PAYMENT_METHOD_CODE, enabled: true, checker,
        translations: [{ languageCode: LanguageCode.en, name: 'Tally POS', description: '' }],
        handler: { code: tallyPaymentHandler.code, arguments: [] },
      });
    } else {
      if (!payment.channels.some(channel => idsAreEqual(channel.id, ctx.channelId))) {
        await this.channels.assignToChannels(ctx, PaymentMethod, payment.id, [ctx.channelId]);
      }
      if (!payment.checker) await this.paymentMethods.update(ctx, { id: payment.id, checker });
    }
    const walkIn = await this.connection.getRepository(ctx, Customer).findOne({
      where: { emailAddress: WALK_IN_EMAIL, deletedAt: IsNull() }, relations: ['channels'],
    });
    if (!walkIn) {
      unwrap(await this.customers.createOrUpdate(ctx, { emailAddress: WALK_IN_EMAIL, firstName: '', lastName: '' }));
    } else if (!walkIn.channels.some(channel => idsAreEqual(channel.id, ctx.channelId))) {
      await this.channels.assignToChannels(ctx, Customer, walkIn.id, [ctx.channelId]);
    }
  }
}
