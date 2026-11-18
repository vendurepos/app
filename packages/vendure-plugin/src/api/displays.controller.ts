import {
  ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, Headers, HttpCode, Param, Post, Put, Req, UseFilters,
} from '@nestjs/common';
import { Allow, Ctx, ForbiddenError, Permission, RequestContext } from '@vendure/core';
import { tallyPosPairDisplay } from '../config/permissions';
import { DisplayRefusal, DisplaySignallingService } from '../service/display-signalling.service';
import type { SignalMessage } from '../service/display-signalling.service';

const DEVICE_HEADER = 'x-tally-device-id', TOKEN_HEADER = 'x-tally-display-token';
// Input bounds: the seam names none, so these only keep junk out of Postgres. A pairing code is 6 digits today; a token
// or claim secret is 22 characters; an SDP offer is a few kB.
const NAME_MAX = 100, CODE_MAX = 32, SECRET_MAX = 128, PAYLOAD_MAX = 65_536, DEVICE_MAX = 64;
const SIGNAL_TYPES: ReadonlySet<unknown> = new Set(['offer', 'answer', 'ice']);

type Reply = { status(code: number): { json(body: unknown): void } };
type Rule = { check: (value: unknown) => boolean; what: string; optional?: true };

const invalid = (message: string) => new DisplayRefusal('invalid_request', message);
/** A string of `min` to `max` characters with no NUL, which Postgres text refuses. */
const text = (min: number, max: number): Rule['check'] => value =>
  typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The body when it holds only `rules`' fields and each passes, as `strict-shape.ts` checks a command; `invalid_request` otherwise. */
function fields<T>(body: unknown, rules: Record<string, Rule>): T {
  if (!isRecord(body)) throw invalid('body: expected a JSON object');
  const unknown = Object.keys(body).find(key => !Object.hasOwn(rules, key));
  if (unknown !== undefined) throw invalid(`${unknown}: unknown field`);
  for (const [key, rule] of Object.entries(rules)) {
    if (body[key] === undefined ? !rule.optional : !rule.check(body[key])) throw invalid(`${key}: expected ${rule.what}`);
  }
  return body as T;
}

const SIGNAL: Record<string, Rule> = {
  type: { check: value => SIGNAL_TYPES.has(value), what: 'offer, answer or ice' },
  payload: { check: text(0, PAYLOAD_MAX), what: `a string of at most ${PAYLOAD_MAX} characters` },
};
const signal = (body: unknown): SignalMessage => {
  const { type, payload } = fields<SignalMessage>(body, SIGNAL);
  return { type, payload };
};

/** The till's `X-Tally-Device-Id`: 1 to 64 characters, no NUL. */
function deviceId(value: string | undefined): string {
  if (!text(1, DEVICE_MAX)(value)) throw invalid(`X-Tally-Device-Id: expected 1 to ${DEVICE_MAX} characters`);
  return value as string;
}

/** The display's `X-Tally-Display-Token`. A missing or oversized one is a refused token, like an unknown one. */
function token(value: string | undefined): string {
  if (!text(1, SECRET_MAX)(value)) throw new DisplayRefusal('token_refused');
  return value as string;
}

/** Every refusal as `{ code, message }`. Vendure's own `ForbiddenError` (no session, or one without the permission) is `forbidden`. */
@Catch(DisplayRefusal, ForbiddenError)
export class DisplayRefusalFilter implements ExceptionFilter {
  catch(error: DisplayRefusal | ForbiddenError, host: ArgumentsHost): void {
    const refusal = error instanceof DisplayRefusal ? error : new DisplayRefusal('forbidden');
    host.switchToHttp().getResponse<Reply>().status(refusal.status).json({ code: refusal.code, message: refusal.message });
  }
}

/**
 * The customer-display signalling routes (TallyUI ADR-085 U7). `displays/…` is the till side: the cashier's Vendure
 * session and channel token, `TallyPosPairDisplay` only, and `X-Tally-Device-Id`. `display/…` is the display side:
 * public, gated by `X-Tally-Display-Token` (claim and collect by their bodies). Lists answer `{ items }`; snapshots
 * travel as `{ snapshot }`.
 */
@Controller('tally/v1')
@UseFilters(DisplayRefusalFilter)
export class TallyDisplaysController {
  constructor(private readonly displays: DisplaySignallingService) {}

  @Post('displays/codes')
  @HttpCode(200)
  @Allow(tallyPosPairDisplay.Permission)
  mint(@Ctx() ctx: RequestContext, @Headers(DEVICE_HEADER) device?: string) {
    return this.displays.mint(ctx, deviceId(device));
  }

  @Get('displays/pending')
  @Allow(tallyPosPairDisplay.Permission)
  async pending(@Ctx() ctx: RequestContext, @Headers(DEVICE_HEADER) device?: string) {
    return { items: await this.displays.pending(ctx, deviceId(device)) };
  }

  @Post('displays/pending/:claimId/confirm')
  @HttpCode(204)
  @Allow(tallyPosPairDisplay.Permission)
  async confirm(@Ctx() ctx: RequestContext, @Param('claimId') claimId: string, @Headers(DEVICE_HEADER) device?: string) {
    await this.displays.confirm(ctx, deviceId(device), claimId);
  }

  @Post('displays/pending/:claimId/decline')
  @HttpCode(204)
  @Allow(tallyPosPairDisplay.Permission)
  async decline(@Ctx() ctx: RequestContext, @Param('claimId') claimId: string, @Headers(DEVICE_HEADER) device?: string) {
    await this.displays.decline(ctx, deviceId(device), claimId);
  }

  @Get('displays')
  @Allow(tallyPosPairDisplay.Permission)
  async list(@Ctx() ctx: RequestContext, @Headers(DEVICE_HEADER) device?: string) {
    return { items: await this.displays.list(ctx, deviceId(device)) };
  }

  @Get('displays/signals')
  @Allow(tallyPosPairDisplay.Permission)
  async receiveSignals(@Ctx() ctx: RequestContext, @Headers(DEVICE_HEADER) device?: string) {
    return { items: await this.displays.receiveSignals(ctx, deviceId(device)) };
  }

  @Delete('displays/:displayId')
  @HttpCode(204)
  @Allow(tallyPosPairDisplay.Permission)
  async forget(@Ctx() ctx: RequestContext, @Param('displayId') displayId: string, @Headers(DEVICE_HEADER) device?: string) {
    await this.displays.forget(ctx, deviceId(device), displayId);
  }

  @Post('displays/:displayId/signals')
  @HttpCode(204)
  @Allow(tallyPosPairDisplay.Permission)
  async sendSignal(@Ctx() ctx: RequestContext, @Param('displayId') displayId: string, @Body() body: unknown, @Headers(DEVICE_HEADER) device?: string) {
    await this.displays.sendSignal(ctx, deviceId(device), displayId, signal(body));
  }

  @Put('displays/:displayId/snapshot')
  @HttpCode(204)
  @Allow(tallyPosPairDisplay.Permission)
  async postSnapshot(@Ctx() ctx: RequestContext, @Param('displayId') displayId: string, @Body() body: unknown, @Headers(DEVICE_HEADER) device?: string) {
    const held = fields<{ snapshot: unknown }>(body, { snapshot: { check: () => true, what: 'any JSON value' } });
    await this.displays.postSnapshot(ctx, deviceId(device), displayId, held.snapshot);
  }

  @Post('display/claim')
  @HttpCode(200)
  @Allow(Permission.Public)
  claim(@Req() req: { ip?: string }, @Body() body: unknown) {
    const request = fields<{ code: string; displayName: string; token?: string }>(body, {
      code: { check: text(1, CODE_MAX), what: `a string of at most ${CODE_MAX} characters` },
      displayName: { check: text(1, NAME_MAX), what: `a name of 1 to ${NAME_MAX} characters` },
      token: { check: text(1, SECRET_MAX), what: 'the display token', optional: true },
    });
    // Express's req.ip honours the merchant's `trust proxy`; without it, every display behind a proxy is one source.
    return this.displays.claim(req.ip ?? '', request);
  }

  @Post('display/collect')
  @HttpCode(200)
  @Allow(Permission.Public)
  collect(@Body() body: unknown) {
    const { claimSecret } = fields<{ claimSecret: string }>(body, {
      claimSecret: { check: text(1, SECRET_MAX), what: 'the claim secret' },
    });
    return this.displays.collect(claimSecret);
  }

  @Post('display/signals')
  @HttpCode(204)
  @Allow(Permission.Public)
  async displaySendSignal(@Body() body: unknown, @Headers(TOKEN_HEADER) displayToken?: string) {
    const message = signal(body);
    await this.displays.displaySendSignal(token(displayToken), message);
  }

  @Get('display/signals')
  @Allow(Permission.Public)
  async displayReceiveSignals(@Headers(TOKEN_HEADER) displayToken?: string) {
    return { items: await this.displays.displayReceiveSignals(token(displayToken)) };
  }

  @Get('display/snapshot')
  @Allow(Permission.Public)
  async readSnapshot(@Headers(TOKEN_HEADER) displayToken?: string) {
    return { snapshot: await this.displays.readSnapshot(token(displayToken)) };
  }
}
