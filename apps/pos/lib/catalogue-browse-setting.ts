import { defaultStore, type KeyValueStore } from './session';

export const CATEGORY_BROWSE_KEY = 'vendurepos.till.categoryBrowse';
export const VARIATIONS_STYLE_KEY = 'vendurepos.till.variationsStyle';
/** v2's Browse by; the first is the default. */
export const CATEGORY_BROWSE_OPTIONS = [
  { value: 'tiles', label: 'Category tiles' },
  { value: 'chips', label: 'Category chips' },
] as const;
/** v2's Variations; the first is the default. */
export const VARIATIONS_STYLE_OPTIONS = [
  { value: 'drill', label: 'Open in place' },
  { value: 'popover', label: 'Popover' },
  { value: 'list', label: 'List' },
] as const;
export type CategoryBrowse = (typeof CATEGORY_BROWSE_OPTIONS)[number]['value'];
export type VariationsStyle = (typeof VARIATIONS_STYLE_OPTIONS)[number]['value'];

/** The stored choice for this till, or 'tiles' when none or not one of CATEGORY_BROWSE_OPTIONS. */
export function loadCategoryBrowse(store: KeyValueStore = defaultStore()): CategoryBrowse {
  const value = store.getItem(CATEGORY_BROWSE_KEY);
  return CATEGORY_BROWSE_OPTIONS.find((option) => option.value === value)?.value ?? 'tiles';
}
export function saveCategoryBrowse(value: CategoryBrowse, store: KeyValueStore = defaultStore()): void {
  store.setItem(CATEGORY_BROWSE_KEY, value);
}
/** The stored choice for this till, or 'drill' when none or not one of VARIATIONS_STYLE_OPTIONS. */
export function loadVariationsStyle(store: KeyValueStore = defaultStore()): VariationsStyle {
  const value = store.getItem(VARIATIONS_STYLE_KEY);
  return VARIATIONS_STYLE_OPTIONS.find((option) => option.value === value)?.value ?? 'drill';
}
export function saveVariationsStyle(value: VariationsStyle, store: KeyValueStore = defaultStore()): void {
  store.setItem(VARIATIONS_STYLE_KEY, value);
}
