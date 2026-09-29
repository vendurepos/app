import { BadRequestException, Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Allow, Ctx, CurrencyCode, Permission, RequestContext, TransactionalConnection, isGraphQlErrorResult } from '@vendure/core';
import type { GraphQLErrorResult } from '@vendure/core';
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '../vendored/commands';
import { fiscalFiguresErrors } from '../vendored/fiscal-figures';
import { payloadShapeErrors } from '../vendored/payload-shape';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../vendored/versions';
import { OrderCreateService } from './order-create.service';

@Controller('tally/v1/commands')
export class TallyCommandController {
  constructor(private connection: TransactionalConnection, private recipe: OrderCreateService) {}

  @Post()
  @HttpCode(200)
  @Allow(Permission.CreateOrder)
  async commands(
    @Ctx() ctx: RequestContext,
    @Headers('x-tally-protocol') protocol: string | undefined,
    @Body() body: { commands: CommandEnvelope[] },
  ): Promise<{ results: CommandResult[] }> {
    if (protocol !== '1') throw new BadRequestException('X-Tally-Protocol must be 1');
    const results: CommandResult[] = [];
    for (const command of body.commands) {
      if (!SUPPORTED_ORDER_CREATE_VERSIONS.includes(command.version)) {
        results.push({ id: command.id, status: 'rejected', error: {
          code: 'unsupported_version', message: 'Unsupported order.create version', data: { orderCreate: 3 },
        } });
        continue;
      }
      const errors = payloadShapeErrors(command.payload);
      if (command.type !== 'order.create') errors.push('type: expected order.create');
      const payload = command.payload as OrderCreatePayload;
      if (!errors.length && command.version === 3) errors.push(...fiscalFiguresErrors(payload));
      if (errors.length) {
        results.push({ id: command.id, status: 'rejected', error: {
          code: 'invalid_payload', message: errors.join('; '),
        } });
        continue;
      }
      const commandCtx = new RequestContext({
        req: ctx.req, apiType: ctx.apiType, channel: ctx.channel, session: ctx.session,
        languageCode: ctx.languageCode, currencyCode: payload.currency as CurrencyCode,
        isAuthorized: ctx.isAuthorized, authorizedAsOwnerOnly: ctx.authorizedAsOwnerOnly,
      });
      try {
        results.push(await this.connection.withTransaction(commandCtx, txCtx =>
          this.recipe.create(txCtx, { ...command, payload }),
        ));
      } catch (error) {
        const result = error as GraphQLErrorResult;
        if (!isGraphQlErrorResult(result)) throw error;
        results.push({ id: command.id, status: 'rejected', error: {
          code: result.errorCode, message: result.message,
        } });
      }
    }
    return { results };
  }
}
