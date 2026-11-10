import { Controller, Get, Query, Res } from '@nestjs/common';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { tallyPosSell } from '../config/permissions';
import { ReportService } from '../service/report.service';
import type { SalesQuery } from '../service/report.service';

type StatusResponse = { status(code: number): unknown };

// An instant with an explicit offset; `from` is inclusive and `to` exclusive.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
// A range of at most 366 days, so a leap year fits and the day rows stay bounded.
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

function validZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The report's query parameters, checked in order; the first failure is the answer. Unknown keys are ignored. */
export function validateSalesQuery(raw: Record<string, unknown>): SalesQuery | { message: string } {
  for (const key of ['from', 'to'] as const) {
    const value = raw[key];
    if (typeof value !== 'string' || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
      return { message: `${key} must be an ISO date-time with an offset` };
    }
  }
  const from = raw.from as string, to = raw.to as string;
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) return { message: 'to must be after from' };
  if (span > MAX_RANGE_MS) return { message: 'The range is at most 366 days' };
  const { registerId } = raw;
  if (registerId !== undefined && (typeof registerId !== 'string' || !registerId.length || registerId.length > 64)) {
    return { message: 'registerId must be 1 to 64 characters' };
  }
  const timezone = raw.timezone ?? 'UTC';
  if (typeof timezone !== 'string' || !validZone(timezone)) return { message: 'timezone must be an IANA time zone' };
  return { from, to, timezone, ...(registerId !== undefined ? { registerId } : {}) };
}

/**
 * `GET /tally/v1/reports/sales`: the channel's POS sales and refunds in a range. Answers other than 200 are written
 * through the Express response, never thrown, as in the command route.
 */
@Controller('tally/v1')
export class TallyReportsController {
  constructor(private reports: ReportService) {}

  @Get('reports/sales')
  @Allow(tallyPosSell.Permission)
  async sales(@Ctx() ctx: RequestContext, @Query() raw: Record<string, unknown>, @Res({ passthrough: true }) res: StatusResponse) {
    // Every till's order totals, the same data as Vendure's order list, so ReadOrder as well as the till permission.
    if (!ctx.userHasAllPermissions([tallyPosSell.Permission as Permission, Permission.ReadOrder])) {
      res.status(403);
      return { code: 'forbidden', message: 'The sales report needs TallyPosSell and ReadOrder' };
    }
    const query = validateSalesQuery(raw);
    if ('message' in query) {
      res.status(400);
      return { code: 'invalid_query', message: query.message };
    }
    return await this.reports.sales(ctx, query);
  }
}
