import type { RequestContext } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { TallyReceiptEmailController } from '../src/api/receipt-email.controller';
import { ReceiptEmailLimits } from '../src/service/receipt-email-limits.service';

// No database: the controller on its own, with stubs that fail if the route reaches an order or the event bus.
const boom = () => new Proxy({}, { get: () => () => { throw new Error('must not be called'); } });
const make = () => {
  const controller = new TallyReceiptEmailController(boom() as never, boom() as never, { perOrder: 3, perUserPerMinute: 2, perUserPerDay: 500, perChannelPerDay: 1000 }, boom() as never);
  const recent = () => (controller as unknown as { recent: Map<string, number[]> }).recent;
  // `{ extra: 1 }` is refused invalid_payload after the rate-limit step and before any order lookup, so each call counts.
  const send = async (id: string) => (await controller.send({ activeUserId: id, userHasAllPermissions: () => true } as unknown as RequestContext,
    'X', { extra: 1 }, { status() {} })) as { code: string };
  return { recent, send };
};

describe('#318: the receipt-email rate limit map is bounded', () => {
  it('stops at 10,000 users', async () => {
    const { recent, send } = make();
    for (let i = 0; i <= 10_000; i++) await send(`u${i}`);
    expect(recent().size).toBe(10_000);
    expect(recent().has('u0')).toBe(false);
  });

  it('drops the least recently seen user first', async () => {
    const { recent, send } = make();
    await send('a');
    for (let i = 1; i < 10_000; i++) await send(`u${i}`);
    expect((await send('a')).code).toBe('invalid_payload');
    await send('u10000');
    expect(recent().has('u1')).toBe(false);
    expect(recent().has('a')).toBe(true);
    expect((await send('a')).code).toBe('rate_limited');
  });
});

describe('#347: a cap of 0 refuses before the database', () => {
  it('checks every cap, not only perOrder, and touches no connection', async () => {
    const limits = new ReceiptEmailLimits(boom() as never, { perOrder: 3, perUserPerMinute: 20, perUserPerDay: 500, perChannelPerDay: 0 });
    expect(await limits.reserve({ activeUserId: 1, channelId: 1 } as never, 7)).toStrictEqual({ code: 'channel_daily_limit', cap: 0 });
  });
});
