import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SESSION_KEY } from '../session';
import { DEMO_STORE_ORIGIN } from './fetch';

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

it('installs nothing in a normal build: no demo mode, no simulated store, fetch untouched', async () => {
  vi.stubEnv('EXPO_PUBLIC_VENDUREPOS_DEMO', undefined);
  const { DEMO_MODE } = await import('./mode');
  const { demoStore } = await import('./install');
  expect(DEMO_MODE).toBe(false);
  expect(demoStore).toBeNull();
  expect(globalThis.fetch).toBe(realFetch);
});

it('installs nothing for any value but 1', async () => {
  vi.stubEnv('EXPO_PUBLIC_VENDUREPOS_DEMO', 'true');
  const { demoStore } = await import('./install');
  expect(demoStore).toBeNull();
  expect(globalThis.fetch).toBe(realFetch);
});

it('installs the simulated store at module load in the demo build', async () => {
  vi.stubEnv('EXPO_PUBLIC_VENDUREPOS_DEMO', '1');
  const { DEMO_MODE } = await import('./mode');
  const { demoStore } = await import('./install');
  expect(DEMO_MODE).toBe(true);
  expect(demoStore).not.toBeNull();
  expect(globalThis.fetch).not.toBe(realFetch);
  const response = await fetch(`${DEMO_STORE_ORIGIN}/tally/v1/info`);
  expect((await response.json()).contracts.register).toEqual([1]);
  demoStore!.uninstall();
});

it('resets in order: the databases first, then the store, the saved session and the rest of storage, then a reload', async () => {
  const { resetDemo } = await import('./install');
  const steps: string[] = [];
  const values = new Map([[SESSION_KEY, '{}'], ['vendurepos.register_id', 'till']]);
  let releaseDatabases!: () => void;
  const reset = resetDemo({
    store: { reset: () => steps.push('store') },
    storage: {
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { steps.push(`remove ${key}`); values.delete(key); },
      clear: () => { steps.push('clear'); values.clear(); },
    },
    removeDatabases: () => new Promise<void>((resolve) => { steps.push('databases'); releaseDatabases = resolve; }),
    reload: () => steps.push('reload'),
  });
  // Nothing else runs until the databases are gone.
  await Promise.resolve();
  expect(steps).toEqual(['databases']);
  releaseDatabases();
  await reset;
  expect(steps).toEqual(['databases', 'store', `remove ${SESSION_KEY}`, 'clear', 'reload']);
  expect(values.size).toBe(0);
});

it('a failed database removal stops the reset before the store, the session or the reload', async () => {
  const { resetDemo } = await import('./install');
  const steps: string[] = [];
  await expect(resetDemo({
    store: { reset: () => steps.push('store') },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => steps.push('session'), clear: () => steps.push('clear') },
    removeDatabases: () => Promise.reject(new Error('held')),
    reload: () => steps.push('reload'),
  })).rejects.toThrow('held');
  expect(steps).toEqual([]);
});
