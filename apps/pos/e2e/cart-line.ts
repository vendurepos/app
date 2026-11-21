import { expect, type Page } from '@playwright/test';

/** Opens a cart line's quantity keypad and presses one of its action buttons. */
export async function lineAction(page: Page, sku: string, action: 'discount' | 'price' | 'remove'): Promise<void> {
  const popovers = page.getByTestId('quantity-popover');
  // TallyUI 4.0.0 keeps a closed line popover mounted through its fade-out (LinePopover's forceMount), with the same
  // action buttons: let a closing one go before this line's opens, so the action pressed is this line's.
  await expect(popovers).toHaveCount(0);
  await page.getByTestId('cart').getByTestId(`cart-line-${sku}`).getByTestId('quantity-popover-trigger').click();
  await popovers.getByTestId(`quantity-popover-action-${action}`).click();
}
