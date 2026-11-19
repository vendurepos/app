import { Order, RequestContext, VendureEvent } from '@vendure/core';

/** 12.1a: a cashier asked for a till order's receipt by email; `tallyReceiptEmailHandler` (the email entry) sends it. */
export class TallyReceiptEmailEvent extends VendureEvent {
  constructor(public ctx: RequestContext, public order: Order, public emailAddress: string) { super(); }
}
