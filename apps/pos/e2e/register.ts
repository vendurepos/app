import { expect, type Page } from '@playwright/test';

// The till's WIDE_MIN_WIDTH (app/index.tsx): below it the catalogue and the cart are tabs.
const WIDE_MIN_WIDTH = 768;

// A sale needs an open register session: opens this till's drawer with a float. On a narrow screen the open card is
// on the Cart tab, where the catalogue is hidden; on a wide one the catalogue is beside it, so it leaves the category
// tiles for All products.
export async function openRegister(page: Page, float = '100.00') {
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill(float);
  await card.getByTestId('open-register-button').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= WIDE_MIN_WIDTH) await openAllProducts(page);
}

/**
 * The till opens on v2's category tiles (1.5a): opens All products from them, so the product tiles show. A catalogue
 * already on its products (a stored category, or All products already open) is left as it is.
 */
export async function openAllProducts(page: Page) {
  const all = page.getByTestId('category-tile-all');
  const product = page.locator('[data-testid^="product-tile-"]').first();
  await expect(all.or(product).first()).toBeVisible();
  if (await all.isVisible()) await all.click();
  await expect(product).toBeVisible();
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
