import type { Page } from '@playwright/test';

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
