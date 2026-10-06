import { Controller, Get } from '@nestjs/common';
import { Allow, ConfigService, Ctx, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { ADVERTISED_ORDER_CREATE_VERSIONS, REGISTER_VERSIONS } from '../service/constants';
import { taxRoundingFor } from '../service/tax-rounding';
import type { TaxRounding } from '../service/tax-rounding';

export type TallyInfo = { contracts: { 'order.create': number[]; register: number[] }; taxRounding: TaxRounding;
  maxShippingLines: number; lineTax: { none: boolean; classes: boolean }; device?: { name: string } };

/** Capability discovery (ADR 0002 §5), behind Vendure's own auth like the command route. */
@Controller('tally/v1')
export class TallyInfoController {
  // Store-wide, so the same for every channel: mapped once at bootstrap.
  private readonly taxRounding: TaxRounding;

  constructor(configService: ConfigService, private readonly connection: TransactionalConnection) {
    const { taxOptions, entityOptions } = configService;
    this.taxRounding = taxRoundingFor({
      orderTax: taxOptions.orderTaxCalculationStrategy,
      taxLine: taxOptions.taxLineCalculationStrategy,
      money: entityOptions.moneyStrategy,
    });
  }

  @Get('info')
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async info(@Ctx() ctx: RequestContext): Promise<TallyInfo> {
    const info: TallyInfo = { contracts: { 'order.create': [...ADVERTISED_ORDER_CREATE_VERSIONS], register: [...REGISTER_VERSIONS] }, taxRounding: this.taxRounding,
      maxShippingLines: 1, // ADR 0005 ruling (b): one shipping charge per order.
      lineTax: { none: true, classes: true }, // v5 contract §1b: Vendure honours taxStatus none and taxClass.
    };
    const name = await this.deviceName(ctx);
    if (name !== undefined) info.device = { name };
    return info;
  }

  private async deviceName(ctx: RequestContext): Promise<string | undefined> {
    if (ctx.activeUserId === undefined) return undefined;
    // Vendure gives each API key its own user, so the active user identifies the key; @vendure/core doesn't export ApiKey.
    const key = await this.connection.getRepository(ctx, 'ApiKey').findOne({
      where: { user: { id: ctx.activeUserId } }, relations: ['translations'],
    });
    if (!key) return undefined;
    const translations: Array<{ languageCode: string; name: string }> = key.translations;
    const translation = translations.find(item => item.languageCode === ctx.languageCode)
      ?? translations.find(item => item.languageCode === ctx.channel.defaultLanguageCode)
      ?? translations[0];
    return translation?.name.trim() || undefined;
  }
}
