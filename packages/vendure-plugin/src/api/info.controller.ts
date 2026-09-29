import { Controller, Get } from '@nestjs/common';
import { Allow, Permission } from '@vendure/core';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../vendored/versions';

export type TallyInfo = { contracts: { 'order.create': number[] } };

/** Capability discovery (ADR 0002 §5), behind Vendure's own auth like the command route. */
@Controller('tally/v1')
export class TallyInfoController {
  @Get('info')
  @Allow(Permission.CreateOrder)
  info(): TallyInfo {
    return { contracts: { 'order.create': [...SUPPORTED_ORDER_CREATE_VERSIONS] } };
  }
}
