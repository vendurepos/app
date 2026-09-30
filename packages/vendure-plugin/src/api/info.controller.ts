import { Controller, Get } from '@nestjs/common';
import { Allow, ConfigService, Permission } from '@vendure/core';
import { ORDER_CREATE_VERSIONS } from '../service/constants';
import { taxRoundingFor } from '../service/tax-rounding';
import type { TaxRounding } from '../service/tax-rounding';

export type TallyInfo = { contracts: { 'order.create': number[] }; taxRounding: TaxRounding };

/** Capability discovery (ADR 0002 §5), behind Vendure's own auth like the command route. */
@Controller('tally/v1')
export class TallyInfoController {
  // Store-wide, so the same for every channel: mapped once at bootstrap.
  private readonly taxRounding: TaxRounding;

  constructor(configService: ConfigService) {
    const { taxOptions, entityOptions } = configService;
    this.taxRounding = taxRoundingFor({
      orderTax: taxOptions.orderTaxCalculationStrategy,
      taxLine: taxOptions.taxLineCalculationStrategy,
      money: entityOptions.moneyStrategy,
    });
  }

  @Get('info')
  @Allow(Permission.CreateOrder)
  info(): TallyInfo {
    return { contracts: { 'order.create': [...ORDER_CREATE_VERSIONS] }, taxRounding: this.taxRounding };
  }
}
