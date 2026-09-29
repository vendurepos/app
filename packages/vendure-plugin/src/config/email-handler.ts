import { orderConfirmationHandler } from '@vendure/email-plugin';

/**
 * ADR 0002 "No customer email": Vendure's order confirmation, minus POS orders. Install it in
 * EmailPlugin's handlers in place of `orderConfirmationHandler`. In 3.7.3 it fires on
 * OrderStateTransitionEvent to PaymentSettled (S1 finding 6).
 */
export const tallyOrderConfirmationHandler = orderConfirmationHandler
  .filter(event => !event.order.customFields.tallyClientOrderId);
