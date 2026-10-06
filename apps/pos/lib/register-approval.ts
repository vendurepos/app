import { defaultStore, type KeyValueStore } from './session';

export const VARIANCE_LIMIT_KEY = 'vendurepos.register.varianceLimitMinor';

/** This till's limit in minor units, or undefined for no approval. */
export function loadVarianceLimitMinor(store: KeyValueStore = defaultStore()): number | undefined {
  const stored = store.getItem(VARIANCE_LIMIT_KEY);
  const minor = stored === null || stored.trim() === '' ? NaN : Number(stored);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
}

/** Parses an amount from 0 to 100000 with up to two decimals; empty clears the limit. */
export function parseVarianceLimit(text: string): { ok: true; minor: number | undefined } | { ok: false } {
  if (text === '') return { ok: true, minor: undefined };
  if (text.match(/^\d+(?:\.\d{1,2})?$/)?.[0] !== text || Number(text) > 100000) return { ok: false };
  return { ok: true, minor: Math.round(Number(text) * 100) };
}

export function saveVarianceLimitMinor(minor: number | undefined, store: KeyValueStore = defaultStore()): void {
  if (minor === undefined) store.removeItem(VARIANCE_LIMIT_KEY);
  else store.setItem(VARIANCE_LIMIT_KEY, String(minor));
}

/** The typed approver as the closure records it: never presented as verified. */
export function typedApprover(name: string): { approvedBy: string; approvedByName: string } | null {
  name = name.trim();
  return name ? { approvedBy: `typed:${name}`, approvedByName: `${name} (typed)` } : null;
}
