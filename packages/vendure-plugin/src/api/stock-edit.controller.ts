import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  Allow, Ctx, GlobalSettingsService, Permission, ProductVariantService, RequestContext, StockLevel, StockMovementService,
  TransactionalConnection,
} from '@vendure/core';
import { RECIPE_LOCK_TIMEOUT } from '../service/command-ledger';
import { transientKind } from '../service/errors';
import { OrderCreateService, STOCK_LOCK_TIMEOUT } from '../service/order-create.service';

type Answer = { status: number; body: Record<string, unknown> };
const refusal = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Answer =>
  ({ status, body: { code, message, ...extra } });
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** 10.2: the Products panel's stock edit as one compare-and-set, so a sale between the till's read and its write is not undone. */
@Controller('tally/v1')
export class TallyStockEditController {
  constructor(private connection: TransactionalConnection, private recipe: OrderCreateService, private variants: ProductVariantService,
    private globalSettings: GlobalSettingsService, private stockMovements: StockMovementService) {}

  /**
   * Sets the variant's saleable stock to `saleable` only while it still equals `expectedSaleable`, the figure the till showed.
   * The variant's stock_level rows are locked as a sale locks them (lockStock's order and timeout), so a sale in flight and
   * this edit serialise. The compare is on the saleable figure, and on-hand is recomputed from allocated and the threshold
   * under the lock. A change to allocated between the till's read and this write, with saleable unchanged, therefore still
   * passes the compare, and the write keeps the new allocation.
   */
  @Post('variants/:id/stock')
  @HttpCode(200)
  @Allow(Permission.UpdateCatalog, Permission.UpdateProduct)
  async setStock(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const answer = await this.compareAndSet(ctx, id, body);
    res.status(answer.status);
    return answer.body;
  }

  private async compareAndSet(ctx: RequestContext, id: string, body: unknown): Promise<Answer> {
    const input = body as { expectedSaleable?: unknown; saleable?: unknown } | null;
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).sort().join() !== 'expectedSaleable,saleable' || !count(input.expectedSaleable) || !count(input.saleable)) {
      return refusal(400, 'invalid_payload', 'Expected a body of { expectedSaleable, saleable }, both whole numbers of 0 or more');
    }
    const expectedSaleable = input.expectedSaleable as number, saleable = input.saleable as number;
    const variantId = this.recipe.decodeId(id);
    const notFound = refusal(404, 'variant_not_found', `No variant ${id} in this channel`);
    if (variantId === undefined) return notFound;
    try {
      return await this.connection.withTransaction(ctx, async tx => {
        const variant = await this.variants.findOne(tx, variantId);
        if (!variant) return notFound;
        const levels = this.connection.getRepository(tx, StockLevel);
        await levels.query(`SET LOCAL lock_timeout = '${STOCK_LOCK_TIMEOUT}'`);
        const rows = await levels.createQueryBuilder('level').where('level.productVariantId = :variantId', { variantId })
          .orderBy('level.stockLocationId').setLock('pessimistic_write').getMany();
        await levels.query(`SET LOCAL lock_timeout = '${RECIPE_LOCK_TIMEOUT}'`);
        if (rows.length !== 1) return refusal(409, 'stock_level_not_single', `Variant ${id} has ${rows.length} stock levels, not one`);
        const [{ stockOnHand, stockAllocated, stockLocationId }] = rows;
        // The app's stockTarget rule: the global threshold unless the variant opts out.
        const threshold = variant.useGlobalOutOfStockThreshold === false ? variant.outOfStockThreshold ?? 0
          : (await this.globalSettings.getSettings(tx)).outOfStockThreshold;
        const current = Math.max(stockOnHand - stockAllocated - threshold, 0);
        if (current !== expectedSaleable) {
          return refusal(409, 'stock_changed', `The saleable stock is ${current}, not ${expectedSaleable}`, { saleable: current });
        }
        const next = saleable + stockAllocated + threshold;
        if (next !== stockOnHand) await this.stockMovements.adjustProductVariantStock(tx, variantId, [{ stockLocationId, stockOnHand: next }]);
        return { status: 200, body: { saleable, stockOnHand: next } };
      });
    } catch (error) {
      // 55P03 lock_not_available: a sale held the rows past STOCK_LOCK_TIMEOUT; the transaction rolled back, nothing is written.
      if (transientKind(error) === 'lock') return refusal(503, 'stock_busy', 'A sale holds this variant\'s stock; try again');
      throw error;
    }
  }
}
