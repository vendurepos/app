// The email handler is the `@vendurepos/plugin/email` entry (src/email.ts), so this entry never
// requires the optional @vendure/email-plugin.
export { TallyPosPlugin } from './plugin';
export { tallyPosSell } from './config/permissions';
export { TallyPriceStrategy } from './config/strategies';
export { TallyCommand } from './entities/tally-command.entity';
export { OrderCreateService } from './service/order-create.service';
export type { OrderCreateResult, PricingStage, TotalWarning } from './service/order-create.service';
export { RegisterService } from './service/register.service';
export type { RegisterEnvelope, RegisterResult } from './service/register.service';
export {
  TallyRegister, TallyRegisterClosure, TallyRegisterMovement, TallyRegisterSession, TallyRegisterSessionStatus,
} from './entities/register.entities';
export {
  BusinessRejection, INTERNAL_ERROR_CODE, PLATFORM_ERROR_CODE, TransientCommandError,
} from './service/errors';
export type { TransientKind } from './service/errors';
export { CLASSIFICATION, MAPPED_ERROR_RESULTS, PERMANENT_ERROR_RESULTS } from './service/classification';
export { TallyPos1790648006022 } from './migrations/1790648006022-TallyPos';
export { TallyPosVp2a1790720000000 } from './migrations/1790720000000-TallyPosVp2a';
export { TallyPosRegister1790800000000 } from './migrations/1790800000000-TallyPosRegister';
