import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from './session';
import { useRegisterBlind } from './register-blind';

// React's hooks are faked in this file only: the repo has no hook-test harness.
const fake = vi.hoisted(() => ({ initial: [] as unknown[], set: [] as boolean[], effects: [] as (() => unknown)[] }));
vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => { fake.initial.push(initial); return [initial, (value: boolean) => { fake.set.push(value); }]; },
  useEffect: (effect: () => unknown) => { fake.effects.push(effect); },
}));

const session: Session = {
  url: 'https://store.test', channelToken: 'channel-a', email: 'cashier@example.com', token: 'session-token',
  settings: { currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 200000 } },
  stock: { trackInventory: true, outOfStockThreshold: 0 },
};
const approverInfo = { permissions: ['ApproveTallyPosVariance'] };
const useStart = () => {
  fake.initial.length = fake.set.length = fake.effects.length = 0;
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  return { blind: useRegisterBlind(session), answer: () => resolve(new Response(JSON.stringify(approverInfo), { status: 200 })) };
};
afterEach(() => vi.unstubAllGlobals());

it('is blind before the permission read answers, and on a new session again until it answers', async () => {
  const { blind, answer } = useStart();
  expect(blind).toBe(true);
  expect(fake.initial).toEqual([true]);
  fake.effects[0]();
  expect(fake.set).toEqual([true]);
  answer();
  await vi.waitFor(() => expect(fake.set.at(-1)).toBe(false));
});

it('drops a late answer once the session has changed', async () => {
  const { answer } = useStart();
  const cleanup = fake.effects[0]() as () => void;
  cleanup();
  answer();
  await new Promise(done => setTimeout(done, 20));
  expect(fake.set).not.toContain(false);
});
