// The `@vendurepos/plugin/email` entry: the only module that needs @vendure/email-plugin.
import { EntityHydrator, OrderStateTransitionEvent } from '@vendure/core';
import {
  EmailEventListener, orderConfirmationHandler, shippingLinesWithMethod, transformOrderLineAssetUrls,
} from '@vendure/email-plugin';

/**
 * ADR 0002 "No customer email": Vendure's order confirmation, minus POS orders. Install it in
 * EmailPlugin's handlers in place of `orderConfirmationHandler`. In 3.7.3 it fires on
 * OrderStateTransitionEvent to PaymentSettled (S1 finding 6).
 *
 * A handler of its own (review 4): `EmailEventHandler.filter` adds to and returns the same handler,
 * so filtering the default would change it for every user of `orderConfirmationHandler`. This copies
 * the default's configuration from @vendure/email-plugin 3.7.3 (default-email-handlers.ts).
 */
export const tallyOrderConfirmationHandler = new EmailEventListener('order-confirmation')
  .on(OrderStateTransitionEvent)
  .filter(event => event.toState === 'PaymentSettled' && event.fromState !== 'Modifying' && !!event.order.customer)
  .filter(event => !event.order.customFields.tallyClientOrderId)
  .loadData(async ({ event, injector }) => {
    await injector.get(EntityHydrator).hydrate(event.ctx, event.order, {
      relations: ['lines.featuredAsset', 'shippingLines.shippingMethod'],
    });
    transformOrderLineAssetUrls(event.ctx, event.order, injector);
    return { shippingLines: shippingLinesWithMethod(event.order) };
  })
  .setRecipient(event => event.order.customer!.emailAddress)
  .setFrom('{{ fromAddress }}')
  .setSubject('Order confirmation for #{{ order.code }}')
  .setTemplateVars(event => ({ order: event.order, shippingLines: event.data.shippingLines }))
  .setMockEvent(orderConfirmationHandler.mockEvent!);
