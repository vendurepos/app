import { Injectable } from '@nestjs/common';
import { ConfigArgService, Logger, PaymentMethod, TransactionalConnection, TranslatorService } from '@vendure/core';
import type { Order, RequestContext } from '@vendure/core';
import { TALLY_PAYMENT_METHOD_CODE, cashRoundingOf, isTallyMethod, tallyPaymentChecker, tenderKind } from '../config/strategies';
import type { CashRounding } from '../config/strategies';
import type { OrderCreatePayment } from '../vendored/commands';
import { loggerCtx } from './errors';

/** order.create 10 adds methodId, which the vendored 4.1.0 type does not carry yet. */
export type TenderPayment = OrderCreatePayment & { methodId?: string };
export type TenderMethod = { code: string; name: string; kind: 'cash' | 'card' | 'other'; rounding?: CashRounding };
/** R3: a payment recorded under tally-pos because its method could not take it; the till ignores the code as unknown. */
export type MethodFallback = { code: 'payment_method_fallback'; clientPaymentId: string; methodId: string; reason: 'disabled' | 'ineligible' | 'unknown' | 'duplicate_code' };
/** The channel's Tally methods, and the codes two or more enabled methods of any handler share there: Vendure picks either one. */
export type TallyMethods = PaymentMethod[] & { shared: Set<string> };

/** 3.2a: the channel's Tally POS payment methods, Vendure PaymentMethods on the plugin's own handler. */
@Injectable()
export class PaymentMethodsService {
  constructor(private connection: TransactionalConnection, private configArgs: ConfigArgService, private translator: TranslatorService) {}

  /** Every Tally method in ctx's channel, enabled or not, id ascending. The handler is a JSON column, so it is filtered here. */
  async tallyMethods(ctx: RequestContext): Promise<TallyMethods> {
    const methods = await this.connection.getRepository(ctx, PaymentMethod).find({
      where: { channels: { id: ctx.channelId } }, relations: ['translations'], order: { id: 'ASC' },
    });
    const enabled = methods.filter(method => method.enabled).map(method => method.code);
    return Object.assign(methods.filter(isTallyMethod), { shared: new Set(enabled.filter((code, index) => enabled.indexOf(code) !== index)) });
  }

  /** Why Vendure cannot resolve this code to exactly one enabled Tally method, or undefined when it can. */
  unusable(methods: TallyMethods, code: string): 'unknown' | 'duplicate_code' | 'disabled' | undefined {
    if (!methods.some(method => method.code === code)) return 'unknown';
    if (methods.shared.has(code)) return 'duplicate_code';
    return methods.some(method => method.code === code && method.enabled) ? undefined : 'disabled';
  }

  /** The methods a till may offer: usable, no checker or the plugin's own, never the plugin's own tally-pos row. */
  async listed(ctx: RequestContext, methods?: TallyMethods): Promise<TenderMethod[]> {
    const tally = methods ?? await this.tallyMethods(ctx);
    return tally.filter(method => method.enabled && !tally.shared.has(method.code) && method.code !== TALLY_PAYMENT_METHOD_CODE
        && (!method.checker || method.checker.code === tallyPaymentChecker.code))
      .map(method => {
        const rounding = cashRoundingOf(method);
        return { code: method.code, name: this.translator.translate(method, ctx).name, kind: tenderKind(method), ...(rounding ? { rounding } : {}) };
      });
  }

  /** R2: each payment's method code (a methodId naming no Tally method falls back at payment time, R3), and the shared codes. */
  async resolve(ctx: RequestContext, payments: TenderPayment[]): Promise<{ codes: string[]; shared: Set<string> }> {
    const methods = await this.tallyMethods(ctx);
    const listed = await this.listed(ctx, methods);
    const codes: string[] = [];
    for (const { method, methodId } of payments) {
      codes.push(methodId ?? (listed.some(tally => tally.code === method) ? method : TALLY_PAYMENT_METHOD_CODE));
    }
    return { codes, shared: methods.shared };
  }

  /**
   * R3: why each resolved code (other than tally-pos) cannot take a payment now, decided before createPayment from the
   * channel's methods, never Vendure's getEligiblePaymentMethods, which runs every method's checker in the channel.
   */
  async fallbacks(ctx: RequestContext, order: Order, codes: string[]): Promise<Map<string, MethodFallback['reason']>> {
    const reasons = new Map<string, MethodFallback['reason']>();
    const own = [...new Set(codes)].filter(code => code !== TALLY_PAYMENT_METHOD_CODE);
    if (!own.length) return reasons;
    const methods = await this.tallyMethods(ctx);
    for (const code of own) {
      let reason: MethodFallback['reason'] | undefined = this.unusable(methods, code);
      const method = methods.find(tally => tally.code === code && tally.enabled);
      // Only the method's own checker runs, as Vendure runs it (payment-method.service.js:219-220); a throw is ineligible.
      if (!reason && method?.checker) {
        try {
          const eligible = await this.configArgs.getByCode('PaymentMethodEligibilityChecker', method.checker.code)
            .check(ctx, order, method.checker.args, this.translator.translate(method, ctx));
          if (eligible === false || typeof eligible === 'string') reason = 'ineligible';
        } catch (error) {
          Logger.warn(`Payment method ${code}: its eligibility checker threw (${error instanceof Error ? error.message : String(error)})`, loggerCtx);
          reason = 'ineligible';
        }
      }
      if (reason) reasons.set(code, reason);
    }
    return reasons;
  }
}
