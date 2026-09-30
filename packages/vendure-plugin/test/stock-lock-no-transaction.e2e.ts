import { Logger, StockLevel, TransactionalConnection } from '@vendure/core';
import type { Injector, OrderLine, RequestContext, StockLocationStrategy } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TallyStockLocationStrategy, unprotectedStockWrites } from '../src/config/strategies';

// #67 follow-up: a stock write outside a transaction cannot take the #62 finding 5 lock, so it is never skipped silently.
const methods = ['forAllocation', 'forRelease', 'forSale', 'forCancellation'] as const;
const plan = [{ location: { id: 1 }, quantity: 2 }];

function strategy() {
  const inner = Object.fromEntries(methods.map(method => [method, vi.fn(async () => plan)])) as unknown as StockLocationStrategy;
  const levels = { manager: { queryRunner: { isTransactionActive: false } }, createQueryBuilder: vi.fn() };
  const connection = {
    getRepository: vi.fn((_ctx: RequestContext, entity: unknown) => {
      expect(entity).toBe(StockLevel);
      return levels;
    }),
  };
  const injector = {
    get: (token: unknown) => {
      expect(token).toBe(TransactionalConnection);
      return connection;
    },
  } as unknown as Injector;
  const tally = new TallyStockLocationStrategy(inner);
  tally.init(injector);
  return { tally, inner, levels };
}

const ctx = { copy: () => ctx } as unknown as RequestContext;
const line = { id: 41, productVariantId: 7, customFields: {} } as unknown as OrderLine;
const call = (tally: TallyStockLocationStrategy, method: typeof methods[number]) =>
  (tally[method] as (...args: unknown[]) => Promise<unknown>)(ctx, [], line, 2, []);

describe('the stock lock outside a transaction', () => {
  const nodeEnv = process.env.NODE_ENV;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    error.mockRestore();
  });

  const loud = methods.flatMap(method => ['test', 'development'].map(env => [method, env] as const));
  it.each(loud)('%s rejects under NODE_ENV=%s and never reaches the inner strategy', async (method, env) => {
    process.env.NODE_ENV = env;
    const { tally, inner, levels } = strategy();
    await expect(call(tally, method)).rejects.toThrow(
      new RegExp(`TallyStockLocationStrategy\\.${method} ran outside a transaction \\(order line 41, variant 7\\): `
        + 'its stock write is unprotected \\(#62 finding 5\\)'),
    );
    expect(inner[method]).not.toHaveBeenCalled();
    expect(levels.createQueryBuilder).not.toHaveBeenCalled();
  });

  it.each(methods)('%s under NODE_ENV=production logs at error level, counts and delegates', async method => {
    process.env.NODE_ENV = 'production';
    const { tally, inner, levels } = strategy();
    const before = unprotectedStockWrites();
    await expect(call(tally, method)).resolves.toEqual(plan);
    expect(inner[method]).toHaveBeenCalledOnce();
    expect(levels.createQueryBuilder).not.toHaveBeenCalled();
    expect(unprotectedStockWrites()).toBe(before + 1);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      `TallyStockLocationStrategy.${method} ran outside a transaction (order line 41, variant 7): `
        + `its stock write is unprotected (#62 finding 5); ${before + 1} so far`,
      'TallyPosPlugin',
    );
    await call(tally, method);
    expect(unprotectedStockWrites()).toBe(before + 2);
  });

  it('with NODE_ENV unset, logs, counts and delegates as in production', async () => {
    delete process.env.NODE_ENV;
    const { tally, inner } = strategy();
    const before = unprotectedStockWrites();
    await expect(call(tally, 'forSale')).resolves.toEqual(plan);
    expect(inner.forSale).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(unprotectedStockWrites()).toBe(before + 1);
  });
});
