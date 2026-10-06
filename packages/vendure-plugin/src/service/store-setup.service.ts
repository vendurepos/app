import { Injectable } from '@nestjs/common';
import {
  ChannelService, Customer, CustomerService, LanguageCode, PaymentMethod, PaymentMethodService, RequestContext,
  Product, ProductService, ProductVariant, ProductVariantService, TaxCategory, TaxCategoryService,
  ShippingMethod, ShippingMethodService, TransactionalConnection, idsAreEqual, manualFulfillmentHandler,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import {
  TALLY_PAYMENT_METHOD_CODE, TALLY_SHIPPING_METHOD_CODE, tallyPaymentChecker, tallyPaymentHandler,
  tallyShippingCalculator, tallyShippingChecker,
} from '../config/strategies';
import { TALLY_CUSTOM_ITEM_SKU, TALLY_NO_TAX_CATEGORY, WALK_IN_EMAIL } from './constants';
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
    private taxCategories: TaxCategoryService,
    private products: ProductService,
    private variants: ProductVariantService,
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
    // ADR 0005 ruling (a): shared custom-item entities, assigned to each channel without changing its default tax.
    const noTax = await this.connection.getRepository(ctx, TaxCategory).findOneBy({ name: TALLY_NO_TAX_CATEGORY })
      ?? await this.taxCategories.create(ctx, { name: TALLY_NO_TAX_CATEGORY });
    // Vendure prices a new variant in the channel's tax zone; a channel without one cannot sell either.
    if (!ctx.channel.defaultTaxZone) return;
    const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
      where: { sku: TALLY_CUSTOM_ITEM_SKU, deletedAt: IsNull() }, relations: ['channels', 'product', 'product.channels'],
    });
    if (!variant) {
      const languageCode = ctx.channel.defaultLanguageCode;
      const product = await this.products.create(ctx, {
        enabled: false, translations: [{ languageCode, name: 'POS custom item', slug: 'vendurepos-custom-item',
          description: 'Used by VendurePOS for custom till lines. Keep it disabled; the shop never shows it.' }],
      });
      await this.variants.create(ctx, [{
        productId: product.id, sku: TALLY_CUSTOM_ITEM_SKU, enabled: true, price: 0,
        // GlobalFlag.FALSE's value, from @vendure/common, which the plugin does not depend on.
        taxCategoryId: noTax.id, trackInventory: 'FALSE' as never, translations: [{ languageCode, name: 'POS custom item' }],
      }]);
    } else if (!variant.channels.some(channel => idsAreEqual(channel.id, ctx.channelId))) {
      await this.channels.assignToChannels(ctx, Product, variant.product.id, [ctx.channelId]);
      await this.channels.assignToChannels(ctx, ProductVariant, variant.id, [ctx.channelId]);
      await this.variants.createOrUpdateProductVariantPrice(ctx, variant.id, 0, ctx.channelId, ctx.channel.defaultCurrencyCode);
    }
  }
}
