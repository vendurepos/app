import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { Allow, Ctx, Logger, Permission, RequestContext } from '@vendure/core';
import { markTallyRoute } from '../config/strategies';
import { TransientCommandError, loggerCtx } from '../service/errors';
import { OrderCreateService } from '../service/order-create.service';
import type { OrderCreateResult } from '../service/order-create.service';
import type { CommandEnvelope, OrderCreatePayload } from '../vendored/commands';

// TallyUI ADR-038: a batch holds 1 to 50 commands; more answers 413 batch_too_large (ruling 18).
const MAX_COMMANDS = 50;

type StatusResponse = { status(code: number): unknown };
type Envelope = CommandEnvelope<OrderCreatePayload>;
type TooLarge = { status: 413; code: 'batch_too_large'; maxCommands: number; message: string };

/** ADR 0002 §2 step 1: every envelope in the batch, before any command is claimed. */
export function validateBatch(body: unknown): { commands: Envelope[] } | { message: string } | TooLarge {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const commands = object(body) ? body.commands : undefined;
  if (!Array.isArray(commands)) return { message: 'Expected a body of { commands }' };
  if (commands.length > MAX_COMMANDS) {
    return { status: 413, code: 'batch_too_large', maxCommands: MAX_COMMANDS, message: `At most ${MAX_COMMANDS} commands are allowed` };
  }
  if (commands.length < 1) return { message: `Expected 1 to ${MAX_COMMANDS} commands` };
  for (const [index, command] of commands.entries()) {
    if (!object(command)) return { message: `Invalid commands[${index}]: expected an object` };
    const field = typeof command.id !== 'string' || !command.id.length || command.id.length > 64 ? 'id'
      : typeof command.type !== 'string' ? 'type'
      : !Number.isSafeInteger(command.version) || (command.version as number) < 1 ? 'version'
      : !object(command.payload) ? 'payload'
      : typeof command.createdAt !== 'string' ? 'createdAt'
      : typeof command.deviceId !== 'string' ? 'deviceId'
      : !Number.isSafeInteger(command.attempt) || (command.attempt as number) < 1 ? 'attempt'
      : undefined;
    if (field) return { message: `Invalid commands[${index}].${field}` };
  }
  return { commands: commands as Envelope[] };
}

/**
 * `POST /tally/v1/commands` (ADR 0002 §1–2). Bodies other than 200 are written through the
 * Express response, never thrown: Vendure's ExceptionLoggerFilter rewrites a thrown HttpException.
 */
@Controller('tally/v1')
export class TallyCommandsController {
  constructor(private orders: OrderCreateService) {}

  @Post('commands')
  @HttpCode(200)
  @Allow(Permission.CreateOrder)
  async commands(
    @Ctx() ctx: RequestContext,
    @Headers('x-tally-protocol') protocol: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusResponse,
  ) {
    if (protocol !== '1') {
      res.status(400);
      return { code: 'unsupported_protocol', message: 'Expected X-Tally-Protocol: 1' };
    }
    const batch = validateBatch(body);
    if ('status' in batch) {
      const { status, ...tooLarge } = batch;
      res.status(status);
      return tooLarge;
    }
    if ('message' in batch) {
      res.status(400);
      return { code: 'invalid_payload', message: batch.message };
    }
    markTallyRoute(ctx);
    const results: OrderCreateResult[] = [];
    for (const command of batch.commands) {
      try {
        results.push(await this.orders.create(ctx, command));
      } catch (error) {
        // Stop at the first transient result; the earlier commands have committed and replay as duplicate.
        const kind = error instanceof TransientCommandError ? error.kind : 'unclassified';
        const cause = error instanceof TransientCommandError ? error.cause : error;
        Logger.warn(`order.create ${command.id} is transient (${kind}): ${cause instanceof Error ? cause.message : String(cause)}`, loggerCtx);
        if (kind === 'lock' || kind === 'needs_admin') {
          res.status(409);
          return { code: 'in_progress', id: command.id };
        }
        res.status(503);
        return { code: 'transient', id: command.id, message: 'Temporary failure, retry later.' };
      }
      await this.orders.runTestHook('afterCommit', command.id);
    }
    return { results };
  }
}
