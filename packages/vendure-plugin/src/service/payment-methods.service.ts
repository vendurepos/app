import { Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentMethodService, TransactionalConnection, TranslatorService } from '@vendure/core';
import type { Order, RequestContext } from '@vendure/core';
import { TALLY_PAYMENT_METHOD_CODE, isTallyMethod, tallyPaymentChecker, tenderKind } from '../config/strategies';
import type { OrderCreatePayment } from '../vendored/commands';

/** order.create 10 adds methodId, which the vendored 4.1.0 type does not carry yet. */
export type TenderPayment = OrderCreatePayment & { methodId?: string };
export type TenderMethod = { code: string; name: string; kind: 'cash' | 'card' | 'other' };
/** R3: a payment recorded under tally-pos because its method could not take it; the till ignores the code as unknown. */
export type MethodFallback = { code: 'payment_method_fallback'; clientPaymentId: string; methodId: string; reason: 'disabled' | 'ineligible' };
/** R1: the first payment whose methodId names no Tally method in the channel. */
export type InvalidMethod = { index: number; clientPaymentId: string; methodId: string };

/** 3.2a: the channel's Tally POS payment methods, Vendure PaymentMethods on the plugin's own handler. */
@Injectable()
export class PaymentMethodsService {
  constructor(private connection: TransactionalConnection, private methods: PaymentMethodService, private translator: TranslatorService) {}

  /** Every Tally method in ctx's channel, enabled or not, id ascending. The handler is a JSON column, so it is filtered here. */
  async tallyMethods(ctx: RequestContext): Promise<PaymentMethod[]> {
    const methods = await this.connection.getRepository(ctx, PaymentMethod).find({
      where: { channels: { id: ctx.channelId } }, relations: ['translations'], order: { id: 'ASC' },
    });
    return methods.filter(isTallyMethod);
  }

  /** The methods a till may offer: enabled, no checker or the plugin's own, never the plugin's own tally-pos row. */
  async listed(ctx: RequestContext, methods?: PaymentMethod[]): Promise<TenderMethod[]> {
    return (methods ?? await this.tallyMethods(ctx))
      .filter(method => method.enabled && method.code !== TALLY_PAYMENT_METHOD_CODE
        && (!method.checker || method.checker.code === tallyPaymentChecker.code))
      .map(method => ({ code: method.code, name: this.translator.translate(method, ctx).name, kind: tenderKind(method) }));
  }

  /** R1 and R2: each payment's method code, or the first methodId that names no Tally method in the channel. */
  async resolve(ctx: RequestContext, payments: TenderPayment[]): Promise<{ codes: string[] } | { invalid: InvalidMethod }> {
    const methods = await this.tallyMethods(ctx);
    const listed = await this.listed(ctx, methods);
    const codes: string[] = [];
    for (const [index, { clientPaymentId, method, methodId }] of payments.entries()) {
      if (methodId !== undefined && !methods.some(tally => tally.code === methodId)) return { invalid: { index, clientPaymentId, methodId } };
      codes.push(methodId ?? (listed.some(tally => tally.code === method) ? method : TALLY_PAYMENT_METHOD_CODE));
    }
    return { codes };
  }

  /**
   * R3: why each resolved code (other than tally-pos) cannot take a payment now, decided before createPayment from
   * Vendure's own eligibility, read once per order: absent from it is disabled, a failing checker is ineligible.
   */
  async fallbacks(ctx: RequestContext, order: Order, codes: string[]): Promise<Map<string, MethodFallback['reason']>> {
    const reasons = new Map<string, MethodFallback['reason']>();
    const own = codes.filter(code => code !== TALLY_PAYMENT_METHOD_CODE);
    if (!own.length) return reasons;
    const eligible = await this.methods.getEligiblePaymentMethods(ctx, order);
    for (const code of own) {
      const found = eligible.find(method => method.code === code);
      if (!found) reasons.set(code, 'disabled');
      else if (!found.isEligible) reasons.set(code, 'ineligible');
    }
    return reasons;
  }
}
