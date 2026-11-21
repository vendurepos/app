import { expect, type Page } from '@playwright/test';

export async function checkout(page: Page) {
  await page.getByTestId('cart').getByTestId('checkout').click();
}

export async function typeAmount(page: Page, amount: string) {
  for (const digit of amount.replace('.', '').replace(/^0+/, '')) {
    await page.getByTestId(`tender-keypad-key-${digit}`).click();
  }
}

export async function takePayment(page: Page) {
  await page.getByTestId('tender-pane').getByTestId('tender-take').click();
}

/**
 * The tender's balance while the entry still equals it (nothing typed, or the pane's own pre-typed amount). TallyUI
 * 4.0.0's TenderPane shows that figure once, as the big entry amount, and leaves `tender-balance` out of the caption
 * until the entry differs from the balance (its `balanceInCaption`), so the absent caption figure is part of the check.
 */
export async function expectBalanceAsEntry(page: Page, amount: string) {
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-figure').getByTestId('tender-entry-amount')).toHaveText(amount);
  await expect(tender.getByTestId('tender-balance')).toHaveCount(0);
}
