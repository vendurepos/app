import { clearSession, type KeyValueStore } from '../session';
import { DEMO_STORE_ORIGIN, installDemoStore } from './fetch';
import { DEMO_MODE } from './mode';

/** The simulated store, installed at module load: app/_layout.tsx imports this first, so it answers before the session
 * loads or anything fetches. Null in a normal build, which never installs it. */
export const demoStore = DEMO_MODE ? installDemoStore(DEMO_STORE_ORIGIN) : null;

export type ResetDemoSteps = {
  store: { reset(): void };
  storage: KeyValueStore & { clear(): void };
  removeDatabases(): Promise<void>;
  reload(): void;
};

/** Reset demo: back to a fresh visit. The databases go first, so nothing still running writes after the rest is cleared. */
export async function resetDemo({ store, storage, removeDatabases, reload }: ResetDemoSteps): Promise<void> {
  await removeDatabases();
  store.reset();
  clearSession(storage);
  // The till's device and register ids too: a fresh visit has none.
  storage.clear();
  reload();
}
