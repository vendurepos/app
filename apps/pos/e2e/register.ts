import { expect, type Page } from '@playwright/test';

// A sale needs an open register session: opens this till's drawer with a float. On a narrow screen the open card is
// on the Cart tab.
export async function openRegister(page: Page, float = '100.00') {
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill(float);
  await card.getByTestId('open-register-button').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
}
