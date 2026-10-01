import { expect, test, type Page } from '@playwright/test';

// A measurement, not a test (PLAN §1): only scripts/measure-sync.sh runs it, which provides E2E_STORE_URL.
const STORE_URL = process.env.E2E_STORE_URL ?? 'http://127.0.0.1:3400';
// dev/vendure-store/src/constants.ts defines POS_CHANNEL_TOKEN, SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD.
const CHANNEL_TOKEN = 'vendurepos-dev-pos';
const USERNAME = 'superadmin';
const PASSWORD = 'superadmin';
// VENDURE_SEED=large (dev/vendure-store/src/catalogue-large.ts) on the POS channel.
const EXPECTED = { products: 2_000, variants: 5_595 };
// Not a gate, but a sync that never completes is a failure.
const COMPLETE_WITHIN_MS = 10 * 60_000;
// After the first run ends, the product query can still be delivering its last batch to React.
const SETTLE_MS = 15_000;

// Reads the TallyUI Catalogue's props from React: `products` is the app's live db.products.find() over the till's local
// database (lib/use-catalogue.ts), each product document holding its variants; `lastSyncedAt` is set when the first
// replication run finishes.
function catalogueState(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Search or scan barcode / SKU"]');
    const key = input && Object.keys(input).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key ? (input as any)[key] : null; fiber; fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && Array.isArray(props.products) && 'lastSyncedAt' in props) {
        return {
          synced: props.lastSyncedAt !== null,
          products: props.products.length as number,
          variants: props.products.reduce((sum: number, doc: any) => sum + (doc.variants?.length ?? 0), 0) as number,
        };
      }
    }
    return { synced: false, products: 0, variants: 0 };
  });
}

test('initial sync of the large seed', async ({ page }, testInfo) => {
  test.setTimeout(COMPLETE_WITHIN_MS + 2 * 60_000);
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-barcode_field').fill('barcode');
  const t0 = Date.now();
  await page.getByTestId('sign-in-submit').click();
  await page.locator('[data-testid^="product-tile-"]').first().waitFor({ state: 'visible', timeout: COMPLETE_WITHIN_MS });
  const firstRenderMs = Date.now() - t0;
  await expect.poll(async () => (await catalogueState(page)).synced, { timeout: COMPLETE_WITHIN_MS - firstRenderMs, intervals: [100] })
    .toBe(true);
  let counts = { products: 0, variants: 0 };
  await expect.poll(async () => {
    const { products, variants } = await catalogueState(page);
    counts = { products, variants };
    return counts;
  }, { timeout: SETTLE_MS, intervals: [100] }).toEqual(EXPECTED);
  const completeMs = Date.now() - t0;
  console.log(JSON.stringify({ run: testInfo.repeatEachIndex + 1, firstRenderMs, completeMs, ...counts }));
});
