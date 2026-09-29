// The email handler is the `@vendurepos/plugin/email` entry (src/email.ts), so this entry never
// requires the optional @vendure/email-plugin.
export { TallyPosPlugin } from './plugin';
export { TallyPriceStrategy } from './config/strategies';
export { TallyCommand } from './entities/tally-command.entity';
export { OrderCreateService } from './service/order-create.service';
export type { OrderCreateResult, PricingStage, TotalWarning } from './service/order-create.service';
export {
  BusinessRejection, INTERNAL_ERROR_CODE, TransientCommandError, UNKNOWN_REJECTION_CODE, internalErrorCount,
} from './service/errors';
export type { TransientKind } from './service/errors';
export { TallyPos1790648006022 } from './migrations/1790648006022-TallyPos';
