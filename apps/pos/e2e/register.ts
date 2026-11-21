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

/**
 * The closure sheet's cash figure under `label` ("Counted" or "Expected") reads `amount`. TallyUI 4.0.0 draws each as a
 * card with the label above the figure, so the testID holds the amount alone and the label is the line before it.
 */
export async function expectClosureCash(page: Page, label: 'Counted' | 'Expected', amount: string) {
  const figure = page.getByTestId('closure-sheet').getByTestId(`closure-${label.toLowerCase()}-cash`);
  await expect(figure).toHaveText(amount);
  await expect(figure.locator('xpath=preceding-sibling::*[1]')).toHaveText(label);
}
