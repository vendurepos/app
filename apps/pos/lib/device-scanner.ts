import { useSyncExternalStore } from 'react';
import { SCAN_DEDUP_WINDOW_MS, type DeviceScannerErrorHandler, type DeviceScannerSettings, type ScanSourceKind } from '@tallyui/pos';
import { loadScannerAffixes, loadScannerMinLength } from './scanner-settings';
import { defaultStore, type KeyValueStore } from './session';

export function liveScannerSettings(store: KeyValueStore = defaultStore()): DeviceScannerSettings {
  return {
    get prefix() { return loadScannerAffixes(store).prefix; },
    get suffix() { return loadScannerAffixes(store).suffix; },
    get minChars() { return loadScannerMinLength(store); },
  };
}

// Mirrors dedupeScans in @tallyui/pos: only cross-source repeats, with UPC-A/EAN-13 twins sharing a key.
export function createScanDedupe(windowMs = SCAN_DEDUP_WINDOW_MS, now = Date.now) {
  const passed = new Map<string, { kind: ScanSourceKind; time: number }>();
  return {
    run<T>(code: string, kind: ScanSourceKind, handle: (code: string) => T): T | null {
      const time = now();
      for (const [key, previous] of passed) if (Math.abs(time - previous.time) >= windowMs) passed.delete(key);
      const key = /^0\d{12}$/.test(code) ? code.slice(1) : code;
      const previous = passed.get(key);
      if (previous && previous.kind !== kind && Math.abs(time - previous.time) < windowMs) return null;
      passed.set(key, { kind, time });
      return handle(code);
    },
  };
}

let scannerError: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const reportScannerError: DeviceScannerErrorHandler = (error, { cancelled }) => {
  if (cancelled) return;
  scannerError = error instanceof Error ? error.message : String(error);
  listeners.forEach((listener) => listener());
};
export function clearScannerError(): void {
  scannerError = null;
  listeners.forEach((listener) => listener());
}
export function useScannerError(): string | null {
  return useSyncExternalStore(subscribe, () => scannerError, () => null);
}
