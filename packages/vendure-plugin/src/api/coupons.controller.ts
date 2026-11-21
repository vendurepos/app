import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { CouponPricingService } from '../service/coupon-pricing';

@Controller('tally/v1')
export class TallyCouponsController {
  constructor(private pricing: CouponPricingService) {}

  @Post('coupons/price')
  @HttpCode(200)
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async price(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const answer = await this.pricing.price(ctx, body);
    res.status(answer.status);
    return answer.body;
  }
}
