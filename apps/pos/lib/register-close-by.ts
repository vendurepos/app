import { defaultStore, type KeyValueStore } from './session';

/** Prefix for this device's per-register Close by time. */
export const CLOSE_BY_KEY_PREFIX = 'vendurepos.register.closeBy.';
// The register id makes a later move to the store a copy; a second device on the same register keeps its own.
/** The storage key for a register's Close by time. */
export function closeByKey(registerId: string): string {
  return CLOSE_BY_KEY_PREFIX + registerId;
}

/** Parses a 24-hour time as HH:mm; empty clears it. */
export function parseCloseBy(text: string): { ok: true; time: string | undefined } | { ok: false } {
  text = text.trim();
  if (text === '') return { ok: true, time: undefined };
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text)) return { ok: false };
  return { ok: true, time: text.padStart(5, '0') };
}

/** This device's Close by time for a register, or undefined when absent or invalid. */
export function loadCloseBy(registerId: string, store: KeyValueStore = defaultStore()): string | undefined {
  const result = parseCloseBy(store.getItem(closeByKey(registerId)) ?? '');
  return result.ok ? result.time : undefined;
}

/** Saves a register's Close by time on this device, or removes it for undefined. */
export function saveCloseBy(registerId: string, time: string | undefined, store: KeyValueStore = defaultStore()): void {
  if (time === undefined) store.removeItem(closeByKey(registerId));
  else store.setItem(closeByKey(registerId), time);
}
