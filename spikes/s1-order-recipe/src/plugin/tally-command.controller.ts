import { BadRequestException, Body, Controller, Headers, HttpCode, HttpException, Post, Res } from '@nestjs/common';
import {
  Allow, Ctx, CurrencyCode, Order, PaymentMethod, Permission, RequestContext, ShippingMethod,
  TaxRate, TransactionalConnection,
} from '@vendure/core';
import type { Response } from 'express';
import { IsNull } from 'typeorm';
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '../vendored/commands';
import { commandFingerprint } from '../vendored/fingerprint';
import { fiscalFiguresErrors } from '../vendored/fiscal-figures';
import { payloadShapeErrors } from '../vendored/payload-shape';
import { SUPPORTED_ORDER_CREATE_VERSIONS } from '../vendored/versions';
import { OrderCreateService } from './order-create.service';
import { TallyCommand } from './tally-command.entity';
import { BusinessRejection } from './unwrap';

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
    @Headers('x-s1-delay-ms') delay: string | undefined,
    @Headers('x-s1-crash-after-commit') crash: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ results: CommandResult[] } | { code: string; id: string; message?: string }> {
    if (protocol !== '1') throw new BadRequestException('X-Tally-Protocol must be 1');
    if (!body || !Array.isArray(body.commands) || body.commands.length === 0) {
      throw new BadRequestException('Expected non-empty commands array');
    }
    if (body.commands.length > 50) throw new HttpException('At most 50 commands are allowed', 413);
    // Complete validation of the whole batch before the first claim or order write.
    const validated = body.commands.map(command => {
      const errors: string[] = [];
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return { id: '', status: 'rejected', error: {
          code: 'invalid_payload', message: 'Expected command object',
        } } satisfies CommandResult;
      }
      if (typeof command.id !== 'string' || !command.id.length || command.id.length > 64) errors.push('Invalid id');
      if (command.type !== 'order.create') errors.push('type: expected order.create');
      if (!Number.isSafeInteger(command.version) || command.version < 1) errors.push('Invalid version');
      if (typeof command.createdAt !== 'string') errors.push('Invalid createdAt');
      if (typeof command.deviceId !== 'string') errors.push('Invalid deviceId');
      if (!Number.isSafeInteger(command.attempt) || command.attempt < 1) errors.push('Invalid attempt');
      if (!errors.length && !SUPPORTED_ORDER_CREATE_VERSIONS.includes(command.version)) {
        return { id: command.id, status: 'rejected', error: {
          code: 'unsupported_version', message: 'Unsupported order.create version', data: { orderCreate: 3 },
        } } satisfies CommandResult;
      }
      errors.push(...payloadShapeErrors(command.payload));
      const payload = command.payload as OrderCreatePayload;
      if (!errors.length && command.version === 3) errors.push(...fiscalFiguresErrors(payload));
      return errors.length ? { id: command.id, status: 'rejected', error: {
        code: 'invalid_payload', message: errors.join('; '),
      } } satisfies CommandResult : undefined;
    });
    const results: CommandResult[] = [];
    for (const [index, command] of body.commands.entries()) {
      const invalid = validated[index];
      if (invalid) { results.push(invalid); continue; }
      const payload = command.payload as OrderCreatePayload;
      const commandCtx = new RequestContext({
        req: ctx.req, apiType: ctx.apiType, channel: ctx.channel, session: ctx.session,
        languageCode: ctx.languageCode, currencyCode: payload.currency as CurrencyCode,
        isAuthorized: ctx.isAuthorized, authorizedAsOwnerOnly: ctx.authorizedAsOwnerOnly,
      });
      try {
        const existing = await this.connection.getRepository(commandCtx, TallyCommand).findOneBy({ id: command.id });
        if (!existing) {
          const order = await this.connection.getRepository(commandCtx, Order).findOne({
            where: { customFields: { tallyClientOrderId: payload.clientOrderId }, channels: { id: ctx.channelId } },
          });
          if (order) {
            results.push({ id: command.id, status: 'applied', serverRefs: {
              orderId: String(order.id), displayId: order.code, totalMinor: order.totalWithTax,
            } });
            continue;
          }
        }
        const payment = await this.connection.getRepository(commandCtx, PaymentMethod).findOne({
          where: { code: 'tally-pos', enabled: true, channels: { id: ctx.channelId } },
        });
        const shipping = await this.connection.getRepository(commandCtx, ShippingMethod).findOne({
          where: { code: 'tally-in-store', deletedAt: IsNull(), channels: { id: ctx.channelId } },
        });
        const zone = ctx.channel.defaultTaxZone;
        const rates = zone && await this.connection.getRepository(commandCtx, TaxRate).count({
          where: { zoneId: zone.id, enabled: true, customerGroup: IsNull() },
        });
        if (!payment || !shipping || !rates) {
          results.push({ id: command.id, status: 'rejected', error: {
            code: 'store_configuration', message: 'Missing POS payment, shipping, or usable default-zone tax rates',
          } });
          continue;
        }
        try {
          results.push(await this.connection.withTransaction(commandCtx, async txCtx => {
            const replay = await this.claim(txCtx, { ...command, payload });
            if (replay) return replay;
            if (process.env.S1_TEST_HOOKS === '1' && delay) {
              await new Promise(resolve => setTimeout(resolve, Number(delay)));
            }
            return this.recipe.create(txCtx, { ...command, payload });
          }));
        } catch (error) {
          if (!(error instanceof BusinessRejection)) throw error;
          const rejected: CommandResult = { id: command.id, status: 'rejected', error: {
            code: error.code, message: error.message,
          } };
          // The failed order transaction has rolled back, including its claim.
          results.push(await this.connection.withTransaction(commandCtx, async txCtx => {
            const replay = await this.claim(txCtx, { ...command, payload });
            if (replay) return replay;
            await this.connection.getRepository(txCtx, TallyCommand).update(command.id, {
              status: 'rejected', result: { ...rejected },
            });
            return rejected;
          }));
        }
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') {
          res.status(409);
          return { code: 'in_progress', id: command.id };
        }
        res.status(503);
        return { code: 'transient', id: command.id, message: 'Temporary failure, retry later.' };
      }
      if (process.env.S1_TEST_HOOKS === '1' && crash === '1') throw new Error('S1 crash after commit');
    }
    return { results };
  }

  private async claim(ctx: RequestContext, command: CommandEnvelope<OrderCreatePayload>): Promise<CommandResult | undefined> {
    const repository = this.connection.getRepository(ctx, TallyCommand);
    const runner = repository.manager.queryRunner!;
    const table = repository.metadata.tablePath.split('.').map(part => runner.connection.driver.escape(part)).join('.');
    const fingerprint = commandFingerprint(command);
    await runner.query("SET LOCAL lock_timeout = '5s'");
    const rows = await runner.query(
      `INSERT INTO ${table} ("id", "clientOrderId", "fingerprint", "status") VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [command.id, command.payload.clientOrderId, fingerprint, 'pending'],
    );
    await runner.query('SET LOCAL lock_timeout = DEFAULT');
    if (rows.length) return undefined;
    const existing = await repository.findOneByOrFail({ id: command.id });
    if (existing.fingerprint !== fingerprint) return { id: command.id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: 'Command id was already used with a different payload',
    } };
    const stored = existing.result as unknown as CommandResult;
    return { ...stored, status: existing.status === 'rejected' ? 'rejected' : 'duplicate' };
  }
}
