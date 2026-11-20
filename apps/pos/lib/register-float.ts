import { parseMinor, validAmount } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

/** Prefix for this device's per-register opening float in minor units. */
export const FLOAT_KEY_PREFIX = 'vendurepos.register.floatMinor.';
// The register id makes a later move to the store a copy; a second device on the same register keeps its own.
/** The storage key for a register's opening float. */
export function floatKey(registerId: string): string {
  return FLOAT_KEY_PREFIX + registerId;
}

/** Parses an opening float in the currency's minor units; empty clears it. */
export function parseOpeningFloat(text: string, digits: number): { ok: true; minor: number | undefined } | { ok: false } {
  text = text.trim();
  if (text === '') return { ok: true, minor: undefined };
  const minor = validAmount(text, digits) ? parseMinor(text, digits) : NaN;
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 100000000 ? { ok: true, minor } : { ok: false };
}

/** Formats an opening float for the amount field, or empty for none. */
export function formatOpeningFloat(minor: number | undefined, digits: number): string {
  return minor === undefined ? '' : (minor / 10 ** digits).toFixed(digits);
}

/** This device's opening float for a register, or undefined when absent or invalid. */
export function loadOpeningFloatMinor(registerId: string, store: KeyValueStore = defaultStore()): number | undefined {
  const stored = store.getItem(floatKey(registerId));
  const minor = stored && !/\D/.test(stored) ? Number(stored) : NaN;
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 100000000 ? minor : undefined;
}

/** Saves a register's opening float on this device, or removes it for undefined. */
export function saveOpeningFloatMinor(registerId: string, minor: number | undefined, store: KeyValueStore = defaultStore()): void {
  if (minor === undefined) store.removeItem(floatKey(registerId));
  else store.setItem(floatKey(registerId), String(minor));
}
