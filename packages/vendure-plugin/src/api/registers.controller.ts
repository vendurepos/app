import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { RegisterService } from '../service/register.service';

export type TallyRegisterRead = {
  version: 1;
  register: { id: string; receivedAt: string };
  counters: { lastClosureNumber: number; perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number };
  session: null | {
    id: string; status: 'open' | 'counting'; openedAt: string; openedBy: string | null;
    deviceId: string | null; deviceName: string | null; countedFloatMinor: number;
    expected: Record<string, number>; salesCount: number;
    /** Every movement row of the session, oldest first by `createdAt` then `id`. `paidInMinor` and `paidOutMinor` follow the
     * closure item's rule over all of them, so `expected.cash` equals `countedFloatMinor` + the session's cash payments
     * + `paidInMinor` − `paidOutMinor` − its cash refunds. The three fields are additive at version 1. */
    paidInMinor: number; paidOutMinor: number;
    movements: { id: string; type: 'paid_in' | 'paid_out' | 'no_sale' | 'void'; amountMinor: number; reason: string | null;
      voids: string | null; createdAt: string; createdBy: string | null }[];
  };
  closures: { items: TallyClosureRead[]; totalItems: number; skip: number; take: number };
};
/**
 * A closure's frozen figures as `register.closure.submit` stored them; `closureId` is the command result's `serverClosureId`.
 * `countedFloatMinor` is the session's opening float. `paidInMinor` and `paidOutMinor` sum the session's `paid_in` and `paid_out`
 * movements that the submit counted, under `deriveSessionFigures`' rule: of the movements in `movementIds`, skip each `void` row and
 * each row voided by a `void` row in that same list. So `expected.cash` equals `countedFloatMinor` + the cash payments of `orderIds`
 * + `paidInMinor` − `paidOutMinor` − the session's cash refunds. Those three fields are additive at version 1.
 */
export type TallyClosureRead = {
  closureId: string; sessionId: string; registerId: string; number: number; businessDay: string | null;
  openedAt: string; closedAt: string; closedBy: string | null; approvedBy: string | null;
  tillExpected: Record<string, number>; counted: Record<string, number>;
  expected: Record<string, number>; variance: Record<string, number>;
  periodSalesTotalMinor: number; periodRefundsTotalMinor: number;
  perpetualSalesTotalMinor: number; perpetualRefundsTotalMinor: number;
  unsyncedCount: number; unsyncedTotalMinor: number; softwareVersion: string;
  orderIds: string[]; movementIds: string[];
  countedFloatMinor: number; paidInMinor: number; paidOutMinor: number; receivedAt: string;
};

/** One row of `GET /tally/v1/registers`. A register has no name of its own (the plugin's rows, not a Vendure entity): the app labels it by `lastDeviceName`. */
export type TallyRegisterListItem = {
  id: string; receivedAt: string; lastDeviceName: string | null;
  session: null | { status: 'open' | 'counting'; openedAt: string; openedBy: string | null; deviceName: string | null };
};

type StatusResponse = { status(code: number): unknown };

// A query value: the fallback when absent, the number for a plain digit string, otherwise NaN (parseInt would accept "5x").
const queryInt = (value: unknown, fallback: number) => value === undefined ? fallback
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;

/**
 * `GET /tally/v1/registers/:id`: one register of the active channel, its live session and a page of its closures, newest
 * first. Read-only, behind the command route's permission; bodies other than 200 go through the response, as there.
 * `GET /tally/v1/registers` lists the channel's registers, newest session first, at most 100.
 */
@Controller('tally/v1')
export class TallyRegistersController {
  constructor(private registers: RegisterService) {}

  @Get('registers')
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async list(@Ctx() ctx: RequestContext): Promise<{ items: TallyRegisterListItem[] }> {
    return { items: await this.registers.list(ctx) };
  }

  @Get('registers/:id')
  @Allow(tallyPosSell.Permission, Permission.CreateOrder)
  async register(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Query('skip') skipQuery: unknown,
    @Query('take') takeQuery: unknown,
    @Res({ passthrough: true }) res: StatusResponse,
  ) {
    const skip = queryInt(skipQuery, 0);
    const take = queryInt(takeQuery, 20);
    if (!Number.isSafeInteger(skip)) {
      res.status(400);
      return { code: 'invalid_query', message: 'skip must be an integer ≥ 0' };
    }
    if (!Number.isSafeInteger(take) || take < 1 || take > 100) {
      res.status(400);
      return { code: 'invalid_query', message: 'take must be an integer from 1 to 100' };
    }
    const read = await this.registers.read(ctx, id, { skip, take });
    if (!read) {
      res.status(404);
      return { code: 'register_not_found', message: `Unknown register ${id}` };
    }
    const body: TallyRegisterRead = { version: 1, ...read };
    return body;
  }
}
