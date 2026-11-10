import { defaultStore, type KeyValueStore } from './session';
import { WEDGE_MIN_LENGTH } from './use-wedge-scanner';

export const SCANNER_MIN_LENGTH_KEY = 'vendurepos.scanner.minLength';
const SCANNER_MIN_LENGTH_RANGE = { min: 4, max: 32 } as const;

/** The stored shortest scan for this till, or WEDGE_MIN_LENGTH when none or invalid (not a whole number in range). */
export function loadScannerMinLength(store: KeyValueStore = defaultStore()): number {
  const value = Number(store.getItem(SCANNER_MIN_LENGTH_KEY));
  return Number.isInteger(value) && value >= SCANNER_MIN_LENGTH_RANGE.min && value <= SCANNER_MIN_LENGTH_RANGE.max
    ? value : WEDGE_MIN_LENGTH;
}

/** Stores it if valid and returns true; returns false and stores nothing otherwise. */
export function saveScannerMinLength(value: number, store: KeyValueStore = defaultStore()): boolean {
  if (!Number.isInteger(value) || value < SCANNER_MIN_LENGTH_RANGE.min || value > SCANNER_MIN_LENGTH_RANGE.max) return false;
  store.setItem(SCANNER_MIN_LENGTH_KEY, String(value));
  return true;
}

export const SCANNER_PREFIX_KEY = 'vendurepos.scanner.prefix';
export const SCANNER_SUFFIX_KEY = 'vendurepos.scanner.suffix';
export const SCAN_SOUNDS_KEY = 'vendurepos.scanner.sounds';
export interface ScanAffixes { prefix: string; suffix: string }

/** The stored prefix and suffix, each '' when none. */
export function loadScannerAffixes(store: KeyValueStore = defaultStore()): ScanAffixes {
  return { prefix: store.getItem(SCANNER_PREFIX_KEY) ?? '', suffix: store.getItem(SCANNER_SUFFIX_KEY) ?? '' };
}
/** Stores each; an empty one is removed. */
export function saveScannerAffixes({ prefix, suffix }: ScanAffixes, store: KeyValueStore = defaultStore()): void {
  for (const [key, value] of [[SCANNER_PREFIX_KEY, prefix], [SCANNER_SUFFIX_KEY, suffix]]) {
    if (value) store.setItem(key, value); else store.removeItem(key);
  }
}
/** Off unless stored on ('1'). */
export function loadScanSounds(store: KeyValueStore = defaultStore()): boolean {
  return store.getItem(SCAN_SOUNDS_KEY) === '1';
}
export function saveScanSounds(on: boolean, store: KeyValueStore = defaultStore()): void {
  store.setItem(SCAN_SOUNDS_KEY, on ? '1' : '0');
}
/** Takes the prefix off the start and the suffix off what is left's end, each only when it matches exactly. */
export function stripScanAffixes(code: string, { prefix, suffix }: ScanAffixes): string {
  if (prefix && code.startsWith(prefix)) code = code.slice(prefix.length);
  if (suffix && code.endsWith(suffix)) code = code.slice(0, -suffix.length);
  return code;
}
