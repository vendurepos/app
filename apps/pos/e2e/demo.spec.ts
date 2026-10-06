import { expect, test, type Page } from '@playwright/test';
import { CATALOGUE } from '../lib/demo/catalogue';
import { DEMO_STORAGE_KEY } from '../lib/demo/store';

// lib/demo/fetch.ts's DEMO_STORE_ORIGIN, copied because fetch.ts imports a value from @tallyui/core, which Playwright's CommonJS loader cannot require.
const DEMO_STORE_ORIGIN = 'https://demo-store.vendurepos.invalid';

// The demo build (VA9), run by pnpm e2e:demo (scripts/e2e-demo.sh) against the demo export on :8098, with no Vendure
// store running: the simulated store answers in the page (lib/demo/install.ts).

// The mug is the catalogue's first variant, so the simulated store's variant id 1 (lib/demo/store.ts).
const MUG_VARIANT_ID = '1';
const MUG_SEED_STOCK = CATALOGUE[0].variants[0].shopFloorStock;
// Order entries in the Orders panel: "<date> · <total> · <status>" (TallyUI's OrdersList).
const ORDER_ENTRY = /· (Synced|Waiting to sync|Not accepted)$/;

type DemoState = { stock: Record<string, { quantity: number }>; orders: unknown[]; closures: unknown[] };

/** The simulated store's saved state; null before its first write and after a reset. */
async function demoState(page: Page): Promise<DemoState | null> {
  return JSON.parse((await page.evaluate((key) => localStorage.getItem(key), DEMO_STORAGE_KEY)) ?? 'null');
}

async function mugStock(page: Page) {
  return (await demoState(page))?.stock[MUG_VARIANT_ID].quantity ?? MUG_SEED_STOCK;
}

async function expectSignedIn(page: Page) {
  await expect(page.getByTestId('demo-banner')).toContainText('Demo: everything stays in this browser');
  await expect(page.getByTestId('signed-in-store')).toBeVisible();
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeVisible();
}

async function orderEntries(page: Page) {
  await page.getByTestId('orders-open').click();
  const entries = page.getByTestId('orders-panel').getByText(ORDER_ENTRY);
  return entries;
}

test('the demo signs in with one click, sells, runs a register day, keeps it over a reload and resets, all in the page', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const cspConsole: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
    if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
  });

  // The served CSP still lets the SQLite worker compile its wasm, on a script response as on the page.
  const script = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('.js'));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  expect((await script).headers()['content-security-policy']).toContain("'wasm-unsafe-eval'");

  // The public credentials and one click to sign in, then the 10 seeded products.
  await expect(page).toHaveURL(/\/demo$/);
  // Headings in order (Lighthouse heading-order): the header's h1, then the card's h2, and nothing deeper.
  await expect(page.getByRole('heading', { level: 1, name: 'Demo' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'VendurePOS demo store' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0);
  const credentials = page.getByTestId('demo-credentials');
  await expect(credentials).toContainText(`Store URL ${DEMO_STORE_ORIGIN}`);
  await expect(credentials).toContainText('Email cashier@demo.vendurepos.com');
  await expect(credentials).toContainText('Password demo1234');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  expect(await page.getByTestId('sign-in-email').count()).toBe(0);
  for (const { name } of CATALOGUE) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  expect(CATALOGUE).toHaveLength(10);

  // A sale: the register opened with €100.00, 2 × mug for cash, €8.00 × 2 + 19 % = €19.04.
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  await expect(card).toHaveCount(0);
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const line = cart.getByTestId('cart-line-TALLY-MUG');
  await expect(line).toBeVisible();
  await line.getByText('+', { exact: true }).click();
  await cart.getByTestId('pay-cash').click();
  await expect(tender.getByTestId('tender-total')).toContainText('€19.04');
  await tender.getByTestId('cash-tendered').locator('input').fill('19.04');
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt').getByTestId('receipt-total')).toContainText('€19.04');
  const reference = (await page.getByTestId('receipt-order').innerText()).match(/^Order (\S+)/)![1];
  expect(reference).toHaveLength(8);
  await page.getByTestId('new-sale').click();

  // Settled: synced in the Orders panel, nothing pending and nothing needing attention.
  const entries = await orderEntries(page);
  await expect(entries).toHaveText([/€19\.04 · Synced$/]);
  await expect(page.getByTestId('orders-panel').getByText('Needs attention', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('orders-waiting')).toHaveCount(0);
  await expect(page.getByTestId('orders-rejected')).toHaveCount(0);
  await expect(page.getByTestId('orders-panel')).toContainText(reference);
  await page.getByTestId('orders-close').click();
  expect(await mugStock(page)).toBe(MUG_SEED_STOCK - 2);

  // A register day: counted and closed, €100.00 + €19.04 expected, and the Z report.
  await page.getByTestId('register-open-panel').click();
  const panel = page.getByTestId('register-panel');
  await expect(panel.getByTestId('register-panel-expected')).toContainText('€119.04');
  await panel.getByTestId('register-panel-close').click();
  const count = page.getByTestId('register-count');
  await count.getByTestId('count-amount').fill('119.04');
  await count.getByTestId('count-close').click();
  const sheet = page.getByTestId('closure-sheet');
  await expect(sheet.getByTestId('closure-expected-cash')).toHaveText('Expected €119.04');
  await expect(sheet.getByTestId('closure-counted-cash')).toHaveText('Counted €119.04');
  await sheet.getByTestId('closure-print').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed).toEqual(expect.arrayContaining([
    'Z report · Closure #1', 'Sales 1', 'Sales total €19.04', 'Opening float €100.00', 'Cash sales €19.04',
    'Cash expected €119.04', 'Cash counted €119.04', 'Cash variance €0.00',
  ]));
  // The simulated store applied the closure (held until the session's order went, lib/closure-hold.ts).
  await expect.poll(async () => (await demoState(page))?.closures.length, { timeout: 30_000 }).toBe(1);
  await sheet.getByTestId('closure-done').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toHaveCount(0);

  // A reload keeps it all: still signed in, the one order once, the stock 2 down, the register closed.
  await page.reload();
  await expectSignedIn(page);
  await expect(await orderEntries(page)).toHaveText([/€19\.04 · Synced$/]);
  await page.getByTestId('orders-close').click();
  expect((await demoState(page))!.orders).toHaveLength(1);
  expect(await mugStock(page)).toBe(MUG_SEED_STOCK - 2);
  await expect(page.getByTestId('open-register-card')).toBeVisible();
  await expect(page.getByTestId('register-open-panel')).toHaveCount(0);

  // Reset demo: a fresh visit, then one click, with no orders, the register closed and the seed's stock.
  await Promise.all([page.waitForEvent('load'), page.getByTestId('demo-reset').click()]);
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByTestId('signed-in-store')).toHaveCount(0);
  await expect(page.getByTestId('demo-enter')).toBeVisible();
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  expect(await demoState(page)).toBeNull();
  expect(await mugStock(page)).toBe(MUG_SEED_STOCK);
  await expect(page.getByTestId('open-register-card')).toBeVisible();
  await expect(page.getByTestId('register-open-panel')).toHaveCount(0);
  await expect(page.getByTestId('orders-open')).toBeVisible();
  await expect(await orderEntries(page)).toHaveCount(0);

  // Nothing left the page's own origin, and nothing broke the CSP.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(cspConsole).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('one click from a fresh visit at phone width', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const cspConsole: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  const origin = new URL(page.url()).origin;
  await expect(page.getByTestId('demo-enter')).toBeInViewport();
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await expect(page.getByTestId('signed-in-store')).toHaveText('Signed in to VendurePOS demo store');
  await page.getByTestId('tab-cart').click();
  await page.getByTestId('open-register-amount').fill('100.00');
  await page.getByTestId('open-register-button').click();
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('sign-out')).toBeInViewport();
  await expect(page.getByTestId('settings-open')).toBeInViewport();
  await expect(page.getByTestId('register-open-panel')).toBeInViewport();
  await page.getByTestId('register-open-panel').click();
  await expect(page.getByTestId('register-panel-dismiss')).toBeInViewport();
  await page.getByTestId('register-panel-dismiss').click();
  await expect(page.getByTestId('register-panel')).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(cspConsole).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('the sign-in screen links to the demo', async ({ page }) => {
  const cspConsole: string[] = [];
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/sign-in');
  await expect(page.getByTestId('sign-in-email')).toBeVisible();
  await expect(page.getByTestId('sign-in-try-demo')).toBeVisible();
  await page.getByTestId('sign-in-try-demo').click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.goto('/sign-in');
  await page.getByTestId('sign-in-url').fill(DEMO_STORE_ORIGIN);
  await page.getByTestId('sign-in-email').fill('cashier@demo.vendurepos.com');
  await page.getByTestId('sign-in-password').fill('demo1234');
  await page.getByTestId('sign-in-submit').click();
  await expectSignedIn(page);
  expect(cspConsole).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('the demo export serves a sitemap, a robots.txt that names it, and share tags with a canonical', async ({ page, request }) => {
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
  const xml = await sitemap.text();
  expect(xml).toContain('<loc>https://demo.vendurepos.com/</loc>');
  expect(xml).toContain('<loc>https://demo.vendurepos.com/demo</loc>');
  const robots = await request.get('/robots.txt');
  expect(robots.headers()['content-type']).toContain('text/plain');
  expect(await robots.text()).toContain('Sitemap: https://demo.vendurepos.com/sitemap.xml');
  await page.goto('/demo');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://demo.vendurepos.com/demo');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://vendurepos.com/opengraph-image');
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://demo.vendurepos.com/demo');
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
});

test('a storage start failure replaces the sale with its notice, a Reload button and the error to report', async ({ page }) => {
  // No SQLite wasm: the worker's storage cannot start, so the order store's open fails (lib/storage-start-failure.ts).
  await page.route('**/sqlite3.wasm', (route) => route.abort());
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expect(page.getByTestId('storage-failure')).toHaveText("Local storage didn't start. Reload this page.", { timeout: 30_000 });
  await expect(page.getByTestId('storage-failure-reload')).toBeVisible();
  await expect(page.getByTestId('storage-failure-detail')).toContainText('StorageWorkerStartError');
  await expect(page.getByTestId('signed-in-store')).toHaveCount(0);
});

test("Settings keeps the scanner's shortest code for this till", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expect(page.getByTestId('signed-in-store')).toBeVisible();
  await page.getByTestId('settings-open').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('scanner-min-length')).toHaveValue('8');
  await page.getByTestId('scanner-min-length').fill('3');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-error')).toBeVisible();
  await page.getByTestId('scanner-min-length').fill('5');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  // Back while the stack is till → Settings: one till, whose register still opens (a pushed second till couldn't).
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('signed-in-store')).toHaveCount(1);
  await expect(page.getByTestId('open-register-card').getByTestId('open-register-amount')).toBeEditable();
  await page.getByTestId('settings-open').click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.reload();
  await expect(page.getByTestId('scanner-min-length')).toHaveValue('5');
  await expect(page.getByTestId('settings-barcode-field')).toContainText('Barcode custom field:');
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('signed-in-store')).toBeVisible();
  await expect(page.getByTestId('signed-in-store')).toHaveCount(1);
  await expect(page.getByTestId('open-register-card').getByTestId('open-register-amount')).toBeEditable();
});

test("over the till's limit, a close needs a typed approver, recorded as typed", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await page.getByTestId('settings-open').click();
  await page.getByTestId('variance-limit').fill('1.00');
  await page.getByTestId('variance-save').click();
  await expect(page.getByTestId('variance-saved')).toBeVisible();
  await page.getByTestId('settings-back').click();

  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  await page.getByTestId('register-open-panel').click();
  await page.getByTestId('register-panel-close').click();
  await page.getByTestId('count-amount').fill('90.00');
  await page.getByTestId('count-close').click();
  await expect(page.getByTestId('approver-name')).toBeVisible();
  await expect(page.getByTestId('approver-confirm')).toBeDisabled();
  await page.getByTestId('approver-cancel').click();
  await expect(page.getByText('Approval was not granted. The count is unchanged.')).toBeVisible();
  await expect(page.getByTestId('count-amount')).toHaveValue('90.00');
  await page.getByTestId('count-close').click();
  await page.getByTestId('approver-name').fill('Sam');
  await page.getByTestId('approver-confirm').click();
  const sheet = page.getByTestId('closure-sheet');
  await expect(sheet.getByTestId('closure-approved-by')).toHaveText('Approved by Sam (typed)');
  await sheet.getByTestId('closure-done').click();

  await page.getByTestId('settings-open').click();
  await page.getByTestId('variance-limit').fill('');
  await page.getByTestId('variance-save').click();
  await expect(page.getByTestId('variance-saved')).toBeVisible();
  await page.getByTestId('settings-back').click();
});
