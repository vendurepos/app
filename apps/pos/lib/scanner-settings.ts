import { defaultStore, type KeyValueStore } from './session';
import { WEDGE_MIN_LENGTH } from './use-wedge-scanner';

export const SCANNER_MIN_LENGTH_KEY = 'vendurepos.scanner.minLength';
export const SCANNER_MIN_LENGTH_RANGE = { min: 4, max: 32 } as const;

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
