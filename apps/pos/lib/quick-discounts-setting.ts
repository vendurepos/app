import { QUICK_DISCOUNTS } from './cart-line-actions';
import { defaultStore, type KeyValueStore } from './session';

const QUICK_DISCOUNTS_KEY = 'vendurepos.till.quickDiscounts';
/** v2's keypad has room for a short row; more than this is refused. */
export const MAX_QUICK_DISCOUNTS = 6;

/** "5, 10, 15" → [5, 10, 15]: whole percents 1–100, comma- or space-separated, duplicates dropped, order kept; "" → []. */
export function parseQuickDiscounts(text: string): { ok: true; values: number[] } | { ok: false } {
  const values: number[] = [];
  for (const piece of text.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(piece)) return { ok: false };
    const value = Number(piece);
    if (value < 1 || value > 100) return { ok: false };
    if (!values.includes(value)) values.push(value);
  }
  return values.length > MAX_QUICK_DISCOUNTS ? { ok: false } : { ok: true, values };
}

export function formatQuickDiscounts(values: readonly number[]): string {
  return values.join(', ');
}

export function loadQuickDiscounts(store: KeyValueStore = defaultStore()): number[] {
  const stored = store.getItem(QUICK_DISCOUNTS_KEY);
  if (stored === null) return [...QUICK_DISCOUNTS];
  const result = parseQuickDiscounts(stored);
  return result.ok ? result.values : [...QUICK_DISCOUNTS];
}

export function saveQuickDiscounts(values: readonly number[], store: KeyValueStore = defaultStore()): void {
  store.setItem(QUICK_DISCOUNTS_KEY, formatQuickDiscounts(values));
}
