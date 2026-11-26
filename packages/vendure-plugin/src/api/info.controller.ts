import { Controller, Get, Inject } from '@nestjs/common';
import { Allow, ConfigService, Ctx, Permission, RequestContext, TransactionalConnection, ZoneService, idsAreEqual } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { TALLY_RECEIPT_EMAIL } from './receipt-email.controller';
import type { ReceiptEmailCaps } from './receipt-email.controller';
import { DisplaySignallingService } from '../service/display-signalling.service';
import type { IceServer } from '../service/display-signalling.service';
import { ADVERTISED_ORDER_CREATE_VERSIONS, MAX_SHIPPING_LINES, ORDER_REFUND_VERSIONS, REGISTER_VERSIONS } from '../service/constants';
import { PaymentMethodsService } from '../service/payment-methods.service';
import type { TenderMethod } from '../service/payment-methods.service';
import { TALLY_PLUGIN_OPTIONS } from '../service/register.service';
import type { RegisterApprovalOptions } from '../service/register.service';
import { taxRoundingFor } from '../service/tax-rounding';
import type { TaxRounding } from '../service/tax-rounding';
import { taxesByAddress } from '../service/tax-zone-info';
import { sessionChannelPermissions } from '../service/session-permissions';

export type TallyInfo = { contracts: { 'order.create': number[]; register: number[]; 'order.refund': number[] }; taxRounding: TaxRounding;
  /** 5.2a: whether the tax zone can follow the order's address, and the channel's default tax zone's country codes. */
  taxZone: { byAddress: boolean; countries: string[] };
  maxShippingLines: number; lineTax: { none: boolean; classes: boolean }; device?: { name: string };
  /** TallyUI ADR-085 d7, d8: the signalling routes exist; `iceServers` only when the plugin's init option sets it. */
  customerDisplay: { v: 1; snapshot: 1; iceServers?: IceServer[] };
  /** 3.2a: the channel's listed Tally methods, id ascending; [] keeps the till's default tiles. */
  paymentMethods: TenderMethod[];
  /** TallyUI ADR-094: order.create accepts `cashRoundings` at every content version (docs/adr 0009). */
  cashRounding: { v: 1 };
  /** TallyUI 2.10b: fees[] and shipping[] may carry amountIncludesTax. */
  chargeTaxMode: { v: 1 }; receiptEmail?: { v: 1 };
  /** #332: only when the plugin's `registerApproval` option is set. */
  registerApproval?: { thresholdMinor: number };
  /** #487: the caller's own permissions on the active channel (a device-key till cannot read Admin `me`). */
  permissions: string[] };

/** Capability discovery (ADR 0002 §5), behind Vendure's own auth like the command route. */
@Controller('tally/v1')
export class TallyInfoController {
  // Store-wide, so the same for every channel: mapped once at bootstrap.
  private readonly taxRounding: TaxRounding;
  private readonly taxByAddress: boolean;

  constructor(
    configService: ConfigService, private readonly connection: TransactionalConnection, private readonly displays: DisplaySignallingService,
    @Inject(TALLY_RECEIPT_EMAIL) private readonly receiptEmail: ReceiptEmailCaps, // 12.1a: init({ receiptEmail })
    @Inject(TALLY_PLUGIN_OPTIONS) private readonly options: RegisterApprovalOptions,
    private readonly paymentMethods: PaymentMethodsService, private readonly zones: ZoneService,
  ) {
    const { taxOptions, entityOptions } = configService;
    this.taxRounding = taxRoundingFor({
      orderTax: taxOptions.orderTaxCalculationStrategy,
      taxLine: taxOptions.taxLineCalculationStrategy,
      money: entityOptions.moneyStrategy,
    });
    this.taxByAddress = taxesByAddress(taxOptions.taxZoneStrategy);
  }

  @Get('info')
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async info(@Ctx() ctx: RequestContext): Promise<TallyInfo> {
    const info: TallyInfo = { contracts: { 'order.create': [...ADVERTISED_ORDER_CREATE_VERSIONS], register: [...REGISTER_VERSIONS],
      'order.refund': [...ORDER_REFUND_VERSIONS] }, taxRounding: this.taxRounding,
      taxZone: { byAddress: this.taxByAddress, countries: await this.zoneCountries(ctx) },
      maxShippingLines: MAX_SHIPPING_LINES, // ADR 0005 ruling (b): one shipping charge per order.
      lineTax: { none: true, classes: true }, // v5 contract §1b: Vendure honours taxStatus none and taxClass.
      customerDisplay: this.displays.advertisement(), paymentMethods: await this.paymentMethods.listed(ctx),
      cashRounding: { v: 1 }, chargeTaxMode: { v: 1 }, permissions: sessionChannelPermissions(ctx),
    };
    const name = await this.deviceName(ctx);
    if (name !== undefined) info.device = { name };
    if (this.receiptEmail) info.receiptEmail = { v: 1 };
    const approval = this.options.registerApproval;
    if (approval) info.registerApproval = { thresholdMinor: approval.thresholdMinor };
    return info;
  }

  // The till prices in the channel's default tax zone (connector-vendure): its country members, sorted and unique.
  private async zoneCountries(ctx: RequestContext): Promise<string[]> {
    const id = ctx.channel.defaultTaxZone?.id;
    const zone = id === undefined ? undefined : (await this.zones.getAllWithMembers(ctx)).find(item => idsAreEqual(item.id, id));
    return [...new Set((zone?.members ?? []).filter(member => member.type === 'country').map(member => member.code))].sort();
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
