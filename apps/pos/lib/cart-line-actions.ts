/** WCPOS v2's default cart quick-discount presets (−5 / −10 / −15 %); a per-till setting is checklist row 9.10. */
export const QUICK_DISCOUNTS = [5, 10, 15] as const;

export type LineActionId = 'discount' | 'price' | 'remove';

/**
 * The buttons in a cart line's quantity keypad, in this order: Discount; Price only when the till allows price edits
 * AND the price column is folded (otherwise the price cell is its own keypad); Remove last.
 */
export function lineActionIds(options: { canEditPrice: boolean; priceShown: boolean }): LineActionId[] {
  return options.canEditPrice && !options.priceShown ? ['discount', 'price', 'remove'] : ['discount', 'remove'];
}
