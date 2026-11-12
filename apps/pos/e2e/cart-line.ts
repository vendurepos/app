import type { Page } from '@playwright/test';

/** Opens a cart line's quantity keypad and presses one of its action buttons. */
export async function lineAction(page: Page, sku: string, action: 'discount' | 'price' | 'remove'): Promise<void> {
  await page.getByTestId('cart').getByTestId(`cart-line-${sku}`).getByTestId('quantity-popover-trigger').click();
  await page.getByTestId(`quantity-popover-action-${action}`).click();
}
