import { expect, test, type Browser } from '@playwright/test';

// PROTOTYPE (#70, not for merge): screenshots of the narrow-layout and per-rate tax row options for a taste ruling.
// Run alone: pnpm smoke:web e2e/proto-70.spec.ts
const OUT = '/Users/claude/agent/handoff/vendurepos-70-layout';
const STORE_URL = process.env.E2E_STORE_URL ?? 'http://127.0.0.1:3200';
const OPTIONS = ['A', 'B', 'C'] as const;
const SIZES = { 360: { width: 360, height: 780 }, 768: { width: 768, height: 1024 } };

// Each capture has its own context (its own OPFS): a reload straight after sign-in can find the database still held.
// The options are read at load, so they survive the redirect to sign-in and back. A sale is not kept across a load,
// so each capture builds it again: five lines across Standard DE 19% and Reduced DE 7%, two above quantity 1.
async function openWithCart(browser: Browser, width: 360 | 768, layout: string, taxrows: string) {
  const context = await browser.newContext({ viewport: SIZES[width], baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await page.goto(`/?layout=${layout}&taxrows=${taxrows}`);
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill('superadmin');
  await page.getByTestId('sign-in-password').fill('superadmin');
  await page.getByTestId('sign-in-channel_token').fill('vendurepos-dev-pos');
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  const tile = (name: string) => page.getByTestId(`product-tile-${name}`);
  await expect(tile('Tally Fixture Mug')).toBeVisible();
  await tile('Tally Fixture Mug').click();
  for (let i = 0; i < 3; i++) {
    await tile('Espresso Beans').click();
    await page.getByRole('button', { name: /ESP-250/ }).click();
  }
  await tile('Postcard Set').click();
  await tile('Postcard Set').click();
  await tile('Filter Coffee').click();
  await tile('Tote Bag').click();
  if (layout === 'C' && width === 360) {
    await expect(page.getByTestId('tab-cart')).toContainText('Cart (8)');
    await page.getByTestId('tab-cart').click();
  }
  await expect(page.getByTestId('cart').getByTestId(/^cart-line-/)).toHaveCount(5);
  return { page, context };
}

test('#70 layout and per-rate tax row options', async ({ browser }) => {
  test.setTimeout(900_000);
  for (const layout of OPTIONS) {
    for (const width of [360, 768] as const) {
      const { page, context } = await openWithCart(browser, width, layout, 'A');
      await page.screenshot({ path: `${OUT}/layout-${layout}-${width}.png` });
      if (layout === 'C' && width === 360) {
        await page.getByTestId('tab-products').click();
        await page.screenshot({ path: `${OUT}/layout-C-360-products-tab.png` });
      }
      await context.close();
    }
  }
  for (const taxrows of OPTIONS) {
    const { page, context } = await openWithCart(browser, 768, 'A', taxrows);
    await page.screenshot({ path: `${OUT}/taxrows-${taxrows}-cart.png` });
    await page.getByTestId('cart').getByTestId('pay-cash').click();
    const tender = page.getByTestId('tender');
    await tender.getByTestId('cash-tendered').locator('input')
      .fill((await tender.getByTestId('tender-total').innerText()).replace(/[^\d.]/g, ''));
    await tender.getByTestId('tender-complete').click();
    await expect(page.getByTestId('receipt').getByTestId('receipt-total')).toBeVisible();
    await page.screenshot({ path: `${OUT}/taxrows-${taxrows}-receipt.png` });
    await context.close();
  }
});
