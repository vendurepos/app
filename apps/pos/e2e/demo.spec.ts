import fs from 'node:fs';
import { devices, expect, test, type Page } from '@playwright/test';
import { DEMO_CAPTURE_URL } from '../lib/demo/analytics';
import { CATALOGUE } from '../lib/demo/catalogue';
import { DEMO_STORAGE_KEY, DemoStore } from '../lib/demo/store';
import { lineAction } from './cart-line';
import { checkout, takePayment, typeAmount } from './checkout';
import { openRegister } from './register';
import { wedgeScan } from './wedge';

/** Settings from the rail, on one of its sections (v2's tabs, parity 9.1). */
async function openSettings(page: Page, section: string) {
  await page.getByTestId('settings-open').click();
  await page.getByTestId(`settings-section-${section}`).click();
}

declare global {
  interface Window {
    printCalls: number; scanTones: number[];
    cameraStreams: MediaStream[];
    cameraSees: { code: string; format: string } | null;
  }
}

// lib/demo/fetch.ts's DEMO_STORE_ORIGIN, copied because fetch.ts imports a value from @tallyui/core, which Playwright's CommonJS loader cannot require.
const DEMO_STORE_ORIGIN = 'https://demo-store.vendurepos.invalid';

// The demo build (VA9), run by pnpm e2e:demo (scripts/e2e-demo.sh) against the demo export on :8098, with no Vendure
// store running: the simulated store answers in the page (lib/demo/install.ts).

// The mug is the catalogue's first variant, so the simulated store's variant id 1 (lib/demo/store.ts).
const MUG_VARIANT_ID = '1';
// lib/demo/store.ts's products(): a product's id is its CATALOGUE index + 1 (the store module imports @tallyui/core).
const MUG_PRODUCT_ID = String(CATALOGUE.findIndex((product) => product.name === 'Tally Fixture Mug') + 1);
const MUG_SEED_STOCK = CATALOGUE[0].variants[0].shopFloorStock;
// Order entries in the Orders panel: "<date> · <total> · <status>" (TallyUI's OrdersList).
const ORDER_ENTRY = /· (Synced|Waiting to sync|Not accepted)$/;
// The simulated store's 3 seeded orders as table rows, newest first.
const SEEDED_ORDERS = [/DEMO-000003.*€17\.84/, /DEMO-000002.*€23\.52/, /DEMO-000001.*€9\.52/];

// On demo.vendurepos.com (pnpm e2e:hosted) the demo records events at PostHog: answer them here, so no test run
// ever counts as a visitor.
test.beforeEach(async ({ context }) => {
  await context.route(DEMO_CAPTURE_URL, (route) => route.fulfill({ status: 200, body: '' }));
});

type DemoState = { stock: Record<string, { quantity: number }>; orders: unknown[]; closures: unknown[]; sessions: Record<string, { registerId: string; status: string }> };

/** The simulated store's saved state; null before its first write and after a reset. */
async function demoState(page: Page): Promise<DemoState | null> {
  return JSON.parse((await page.evaluate((key) => localStorage.getItem(key), DEMO_STORAGE_KEY)) ?? 'null');
}

async function mugStock(page: Page) {
  return (await demoState(page))?.stock[MUG_VARIANT_ID].quantity ?? MUG_SEED_STOCK;
}

async function expectSignedIn(page: Page) {
  await expect(page.getByTestId('register-bar-cashier')).toBeVisible();
  // The grid renders its tiles lazily (at phone width the mug is past the first screenful), so wait for the first by name.
  await expect(page.getByTestId('product-tile-Canvas Apron')).toBeVisible();
}

test('the camera scan button adds what the camera sees once, follows the scan rules and lets the camera go while the catalogue is hidden', async ({ page }) => {
  await page.addInitScript(() => {
    window.cameraStreams = [];
    window.cameraSees = null;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 48;
        canvas.getContext('2d')!.fillRect(0, 0, 64, 48);
        const stream = canvas.captureStream();
        window.cameraStreams.push(stream);
        return stream;
      },
    } });
    Object.assign(window, { BarcodeDetector: class {
      constructor({ formats }: { formats: string[] }) {
        const supported = ['aztec', 'code_128', 'code_39', 'code_93', 'codabar', 'data_matrix', 'ean_13', 'ean_8', 'itf', 'pdf417', 'qr_code', 'upc_a', 'upc_e'];
        if (formats.some((format) => !supported.includes(format))) throw new TypeError('Unsupported barcode format');
      }
      async detect(source: unknown) {
        if (!(source instanceof HTMLVideoElement)) throw new TypeError('Expected a video element');
        return window.cameraSees ? [{ rawValue: window.cameraSees.code, format: window.cameraSees.format }] : [];
      }
    } });
  });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('camera-scan-button').click();
  await expect(page.getByTestId('camera-scanner-panel')).toBeVisible();
  // The demo signs in with no barcode field, so the camera reads the SKU, as the wedge test types it.
  const mug = { code: 'TALLY-MUG', format: 'code_128' };
  await page.evaluate((seen) => { window.cameraSees = seen; }, mug);
  const line = page.getByTestId('cart-line-TALLY-MUG');
  const inCart = page.getByTestId(`in-cart-${MUG_PRODUCT_ID}`);
  await expect(line).toBeVisible();
  await expect(inCart).toHaveText('1');
  await page.waitForTimeout(2000);
  await expect(inCart).toHaveText('1');
  await page.evaluate(() => { window.cameraSees = null; });
  await page.waitForTimeout(1500);
  await page.evaluate((seen) => { window.cameraSees = seen; }, mug);
  await expect(inCart).toHaveText('2');
  await page.evaluate(() => { window.cameraSees = { code: 'NO-SUCH-CODE', format: 'qr_code' }; });
  await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "NO-SUCH-CODE".');
  await expect(inCart).toHaveText('2');
  await page.evaluate(() => { window.cameraSees = null; });
  const streamsBeforeHide = await page.evaluate(() => window.cameraStreams.length);
  expect(streamsBeforeHide).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('tab-cart').click();
  await expect.poll(() => page.evaluate(() => window.cameraStreams.every((stream) =>
    stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true);
  await page.evaluate((seen) => { window.cameraSees = seen; }, mug);
  await page.waitForTimeout(1000);
  await expect(line).toBeVisible();
  if (await inCart.count()) await expect(inCart).toHaveText('2');
  else await expect(line.getByTestId('quantity-popover-trigger')).toHaveText('2');
  await page.evaluate(() => { window.cameraSees = null; });
  await page.getByTestId('tab-products').click();
  await expect(page.getByTestId('camera-scanner-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.cameraStreams.length)).toBe(streamsBeforeHide + 1);
  await expect.poll(() => page.evaluate(() => window.cameraStreams.at(-1)!.getTracks().some((track) =>
    track.readyState === 'live'))).toBe(true);
});

test("Settings takes the scanner's prefix and suffix off each scan, and scan sounds tell a hit from a miss", async ({ page }) => {
  await page.addInitScript(() => {
    window.scanTones = [];
    window.AudioContext = class {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator() {
        return { frequency: { setValueAtTime(f: number) { window.scanTones.push(f); } }, connect() {}, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
      }
      resume() { return Promise.resolve(); }
    } as unknown as typeof AudioContext;
  });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await openSettings(page, 'barcode');
  await page.getByTestId('scanner-prefix').fill('*');
  await page.getByTestId('scanner-suffix').fill('#');
  await expect(page.getByTestId('scan-sounds-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('scan-sounds-toggle').click();
  await expect(page.getByTestId('scan-sounds-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, '*TALLY-MUG#');
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
  expect(await page.evaluate(() => window.scanTones)).toEqual([880, 1320]);
  await wedgeScan(page, '*NO-SUCH-CODE#');
  await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "NO-SUCH-CODE".');
  expect(await page.evaluate(() => window.scanTones)).toEqual([880, 1320, 330, 220]);
  await page.reload();
  await openSettings(page, 'barcode');
  await expect(page.getByTestId('scanner-prefix')).toHaveValue('*');
  await expect(page.getByTestId('scanner-suffix')).toHaveValue('#');
  await expect(page.getByTestId('scan-sounds-toggle')).toHaveAttribute('aria-checked', 'true');
});

test("Settings' barcode test shows a scan and its last key, and adds nothing to the sale", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await openSettings(page, 'barcode');
  await page.getByTestId('scanner-prefix').fill('*');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await expect(page.getByTestId('scanner-test-code')).toHaveText('None yet');
  await wedgeScan(page, '*TALLY-MUG');
  await expect(page.getByTestId('scanner-test-code')).toHaveText('TALLY-MUG');
  await expect(page.getByTestId('scanner-test-key')).toContainText('Enter');
  await page.getByTestId('scanner-prefix').fill('');
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('cart')).not.toContainText('Tally Fixture Mug');
  // The till listens again once it has the focus back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test('Settings opens beside the rail, and a scan there adds nothing to the sale', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-section-general')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('nav-rail')).toBeVisible();
  await expect(page.getByTestId('nav-item-settings')).toHaveAttribute('aria-current', 'page');
  await expect(page).not.toHaveURL(/\/settings$/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, 'TALLY-MUG');
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('nav-item-settings')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('cart')).toBeVisible();
  await expect(page.getByTestId('cart')).not.toContainText('Tally Fixture Mug');
});

test('Support at the foot of the rail opens the quick start, GitHub issues and the version, and a scan closes it and adds', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('support-open').click();
  await expect(page.getByTestId('support-sheet')).toBeVisible();
  await expect(page.getByTestId('support-quickstart')).toHaveAttribute('href', 'https://vendurepos.com/docs/quick-start');
  await expect(page.getByTestId('support-issues')).toHaveAttribute('href', 'https://github.com/vendurepos/app/issues');
  // apps/pos/app.json's version.
  await expect(page.getByTestId('support-version')).toHaveText('VendurePOS 0.1.0');
  // The foot of the rail: Support sits below Settings.
  const settingsBox = await page.getByTestId('settings-open').boundingBox();
  const supportBox = await page.getByTestId('support-open').boundingBox();
  expect(supportBox!.y).toBeGreaterThan(settingsBox!.y);
  // A scan closes the sheet and adds (docs/scan-policy.md, "A new surface").
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('support-sheet')).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test('a scan on the demo sign-in screen adds nothing to the next sale', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('register-bar-cashier').click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('demo-enter')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, 'TALLY-MUG');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  if (await page.getByTestId('open-register-card').count()) {
    await openRegister(page);
  }
  await expect(page.getByTestId('cart')).not.toContainText('Tally Fixture Mug');
  await expect(page.getByTestId('scan-not-found')).toHaveCount(0);
});

async function orderEntries(page: Page) {
  await page.getByTestId('orders-open').click();
  await page.getByTestId('orders-scope-till').click();
  const entries = page.getByTestId('orders-panel').getByText(ORDER_ENTRY);
  return entries;
}

async function storeRows(page: Page) {
  await page.getByTestId('orders-scope-store').click();
  return page.getByTestId('orders-panel').locator('[data-testid^="orders-row-"]');
}

test("the Orders panel lists the store's orders by day, and searches and filters them", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('orders-open').click();
  const rows = await storeRows(page);
  await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid'))))
    .toEqual(['orders-row-3', 'orders-row-2', 'orders-row-1']);
  await expect(page.getByTestId('orders-row-1')).toContainText('cashier@demo.vendurepos.com');
  await expect(page.locator('[data-testid^="orders-day-"]')).toHaveCount(3);
  await expect(page.getByTestId('orders-count')).toHaveText('Showing 3 of 3 orders');
  await expect(page.getByTestId('orders-more')).toHaveCount(0);

  await page.getByTestId('orders-search').fill('demo-000002');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-testid', 'orders-row-2');
  await page.getByTestId('orders-search').fill('');
  await expect(rows).toHaveCount(3);
  await page.getByTestId('order-filter-status').click();
  await page.getByTestId('order-filter-status-Cancelled').click();
  await expect(page.getByTestId('orders-store-empty')).toHaveText('No orders match this search and these filters.');
  await page.getByTestId('order-filter-status-remove').click();
  await expect(rows).toHaveCount(3);

  await page.getByTestId('order-filter-customer').click();
  await page.getByTestId('order-filter-customer-search').fill('Love');
  await page.getByTestId('order-filter-customer-c1').click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-testid', 'orders-row-3');
  await expect(page.getByTestId('order-filter-customer')).toHaveText('Ada Lovelace');
  await page.getByTestId('orders-row-3').click();
  await expect(page.getByTestId('order-sheet-detail')).toContainText('DEMO-000003');
  await page.getByTestId('order-sheet-close').click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-testid', 'orders-row-3');
  await expect(page.getByTestId('order-filter-customer')).toHaveText('Ada Lovelace');

  await page.getByTestId('orders-scope-till').click();
  await expect(page.getByTestId('orders-empty')).toBeVisible();
  await expect(page.getByTestId('orders-search')).toHaveCount(0);
  await page.getByTestId('orders-open').click();
  await page.getByTestId('orders-open').click();
  await expect(page.getByTestId('orders-scope-till')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('orders-empty')).toBeVisible();
  await expect(page.getByTestId('orders-search')).toHaveCount(0);
});

test("the Customers panel lists the store's customers by surname, searches them, and a scan closes it and adds", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('customers-open').click();
  const rows = page.getByTestId('customers-panel').locator('[data-testid^="customers-row-"]');
  await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))).toEqual([
    'customers-row-c2', 'customers-row-c4', 'customers-row-c6', 'customers-row-c5',
    'customers-row-c1', 'customers-row-c7', 'customers-row-c3', 'customers-row-c8',
  ]);
  await expect(page.getByTestId('customers-row-c1')).toContainText('ada@demo.vendurepos.com');
  await expect(page.getByTestId('customers-row-c1')).toContainText('12 Engine Row');
  await expect(page.getByTestId('customers-row-c1')).toContainText('AL');
  await expect(page.getByTestId('customers-count')).toHaveText('Showing 8 of 8 customers');
  await expect(page.getByTestId('customers-more')).toHaveCount(0);

  await page.getByTestId('customers-search').fill('MEAD');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-testid', 'customers-row-c7');
  await page.getByTestId('customers-search').fill('nobody');
  await expect(page.getByTestId('customers-empty')).toHaveText('No customers match this search.');
  await page.getByTestId('customers-search').fill('');
  await expect(rows).toHaveCount(8);

  await page.getByTestId('customers-open').click();
  await expect(page.getByTestId('customers-panel')).toHaveCount(0);
  await page.getByTestId('customers-open').click();
  await expect(page.getByTestId('customers-panel')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('customers-panel')).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test("the Products panel lists the catalogue's variants with SKU, price and stock, searches them, and a scan closes it and adds", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('products-open').click();
  const panel = page.getByTestId('products-panel');
  const variants = CATALOGUE.flatMap(product => product.variants).length;
  await expect(page.getByTestId('products-count')).toHaveText(`Showing 25 of ${variants} products`);
  const mug = panel.getByTestId(`product-row-${MUG_VARIANT_ID}`);

  await page.getByTestId('products-search').fill('TALLY-MUG');
  await expect(panel.locator('[data-testid^="product-row-"]')).toHaveCount(1);
  await expect(page.getByTestId('products-count')).toHaveText('Showing 1 of 1 products');
  for (const text of ['Tally Fixture Mug', 'TALLY-MUG']) await expect(mug).toContainText(text);
  await expect(mug.getByTestId(`product-price-${MUG_VARIANT_ID}`)).toHaveValue('8.00');
  await expect(mug.getByTestId(`product-stock-${MUG_VARIANT_ID}`)).toHaveValue(String(MUG_SEED_STOCK));

  await page.getByTestId('products-open').click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('products-open').click();
  await expect(panel).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await wedgeScan(page, 'TALLY-MUG');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test("the Products panel edits the mug's price and stock inline, and the sell screen sells it at the new price", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('products-open').click();
  const panel = page.getByTestId('products-panel');
  await page.getByTestId('products-search').fill('TALLY-MUG');
  const price = panel.getByTestId(`product-price-${MUG_VARIANT_ID}`);
  const stock = panel.getByTestId(`product-stock-${MUG_VARIANT_ID}`);

  await expect(price).toHaveValue('8.00');
  await price.fill('abc');
  await price.press('Tab');
  await expect(page.getByTestId('products-save-error')).toHaveText('Enter a price such as 9.50.');
  await expect(price).toHaveValue('8.00');

  await price.fill('9.50');
  await price.press('Tab');
  await stock.fill('12');
  await stock.press('Enter');
  await expect.poll(async () => (await demoState(page))?.stock[MUG_VARIANT_ID].quantity).toBe(12);
  await expect(price).toHaveValue('9.50');
  await expect(stock).toHaveValue('12');
  await expect(page.getByTestId('products-save-error')).toHaveCount(0);

  await page.getByTestId('products-open').click();
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toContainText('€9.50');
});

test("Store health shows Ready to sell, nothing waiting, the products on this device and the store's totals, and a scan closes it and adds", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('store-health-open').click();
  await expect(page.getByTestId('store-health-panel')).toBeVisible();
  await expect(page.getByTestId('nav-item-health-badge')).toHaveCount(0);
  await expect(page.getByTestId('store-health-storage')).toHaveText(/^\d+(\.\d)? (B|KB|MB|GB)$/);
  await expect(page.getByTestId('store-health-stuck-orders')).toHaveCount(0);
  await expect(page.getByTestId('store-health-ready')).toHaveText('✓ Ready to sell');
  await expect(page.getByTestId('store-health-waiting')).toHaveText('0');
  await expect(page.getByTestId('store-health-count-products')).toHaveText(String(CATALOGUE.length));
  // The simulated store's own totals (lib/demo/store.ts), fresh demo: every product, the seeded orders.
  const demoStore = new DemoStore();
  await expect(page.getByTestId('store-health-server-products')).toHaveText(String(demoStore.products().length));
  await expect(page.getByTestId('store-health-server-orders')).toHaveText(String(demoStore.orderSummaries().length));
  await expect(page.getByTestId('store-health-coverage-products')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByTestId('store-health-server-refunds')).toHaveText('—');
  await page.getByTestId('store-health-open').click();
  await expect(page.getByTestId('store-health-panel')).toHaveCount(0);
  await page.getByTestId('store-health-open').click();
  await expect(page.getByTestId('store-health-panel')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('store-health-panel')).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test('Store health checks everything now, and Clear & re-download empties and refills the products and the till still sells', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('store-health-open').click();
  await expect(page.getByTestId('store-health-panel')).toBeVisible();
  await expect(page.getByTestId('store-health-ready')).toHaveText('✓ Ready to sell');
  const checkNow = page.getByTestId('store-health-check-now');
  await checkNow.click();
  await expect(checkNow).toHaveText('Check everything now');
  await expect(checkNow).toBeEnabled();
  const redownload = page.getByTestId('store-health-redownload');
  const confirm = page.getByTestId('store-health-redownload-confirm');
  await redownload.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`${CATALOGUE.length} products are removed`);
  await page.getByTestId('store-health-redownload-cancel').click();
  await expect(confirm).toHaveCount(0);
  // Cancel starts nothing: sampled for a second, the button never reads Re-downloading….
  const words: (string | null)[] = [];
  await expect.poll(async () => words.push(await redownload.textContent()), { intervals: [50] }).toBeGreaterThanOrEqual(20);
  expect([...new Set(words)]).toEqual(['Clear & re-download']);
  await redownload.click();
  await page.getByTestId('store-health-redownload-yes').click();
  // The button returns only on the restarted sync's first pull, so the count and Ready below are the refilled ones.
  await expect(redownload).toHaveText('Clear & re-download');
  await expect(page.getByTestId('store-health-count-products')).toHaveText(String(CATALOGUE.length));
  await expect(page.getByTestId('store-health-ready')).toHaveText('✓ Ready to sell');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test('Notifications at the foot of the rail shows the empty state and closes', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('notifications-open').click();
  await expect(page.getByTestId('notifications-sheet')).toBeVisible();
  await expect(page.getByTestId('notifications-empty')).toContainText('No notifications');
  await expect(page.getByTestId('notifications-empty')).toContainText('Plugin updates and notices about VendurePOS arrive here.');
  await expect(page.getByTestId('notifications-about')).toHaveAttribute('href', 'https://vendurepos.com/docs/notifications');
  await expect(page.getByTestId('notifications-about')).toHaveText('About notifications');
  await page.getByTestId('notifications-close').click();
  await expect(page.getByTestId('notifications-sheet')).toHaveCount(0);
});

test("the demo opens a seeded order and the till's own sale from the Orders panel", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  await page.getByTestId('orders-open').click();
  await (await storeRows(page)).filter({ hasText: 'DEMO-000002' }).click();
  const detail = page.getByTestId('order-sheet-detail');
  await expect(detail).toContainText('DEMO-000002');
  await expect(detail).toContainText('€23.52');
  for (const sku of ['ESP-250', 'FIL-500']) {
    const product = CATALOGUE.find(product => product.variants.some(variant => variant.sku === sku))!;
    await expect(detail).toContainText(product.name);
  }
  await expect(detail).toContainText('Paid €23.52');
  await expect(page.getByTestId('refund-start')).toBeVisible();
  await page.getByTestId('order-sheet-close').click();
  for (const id of ['3', '2', '1']) await expect(page.getByTestId(`orders-row-${id}`)).toBeVisible();
  await page.getByTestId('orders-open').click();

  const mug = CATALOGUE.find(product => product.variants.some(variant => variant.sku === 'TALLY-MUG'))!;
  await page.getByTestId(`product-tile-${mug.name}`).click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('receipt').getByTestId('new-sale').click();
  await expect(await orderEntries(page)).toHaveText([/€9\.52 · Synced$/]);
  await page.getByTestId('orders-panel').getByTestId(/^order-open-/).click();
  await expect(detail).toContainText('Paid €9.52');
  await expect(detail).toContainText(mug.name);
});

// Front desk, 2026-11-15: a scan that closes the Orders panel drops the open order too, so Orders reopens on the list.
test('a scan over an open order closes the Orders panel, and Orders reopens on the list', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('orders-open').click();
  await (await storeRows(page)).filter({ hasText: 'DEMO-000002' }).click();
  await expect(page.getByTestId('order-sheet-detail')).toContainText('DEMO-000002');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('orders-panel')).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
  await page.getByTestId('orders-open').click();
  await expect((await storeRows(page)).filter({ hasText: 'DEMO-000002' })).toBeVisible();
  await expect(page.getByTestId('order-sheet-detail')).toHaveCount(0);
});

test("a demo cashier reprints a finished sale's receipt from the order sheet and prints it alone", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  // One mug, €9.52, paid from €10.00 in cash.
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '10.00');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  const live = page.getByTestId('receipt');
  await expect(live.getByTestId('receipt-total')).toHaveText('€9.52');
  await expect(live.getByTestId('receipt-change')).toHaveText('€0.48');
  const tendered = await live.getByTestId('receipt-payment-cash').textContent();
  await live.getByTestId('new-sale').click();

  // The reprint, built from the order the store holds, shows what the live receipt showed.
  await page.getByTestId('orders-open').click();
  await page.getByTestId('orders-scope-till').click();
  await page.getByTestId('orders-panel').getByTestId(/^order-open-/).click();
  await page.getByTestId('order-sheet-receipt').click();
  const reprint = page.getByTestId('order-receipt');
  await expect(reprint.getByTestId('order-receipt-total')).toHaveText('€9.52');
  await expect(reprint.getByTestId('order-receipt-payment-cash')).toHaveText(tendered!);
  await expect(reprint.getByTestId('order-receipt-change')).toHaveText('€0.48');
  await expect(reprint.getByTestId('order-receipt-order')).toContainText('DEMO-');

  // Playwright can't drive the OS print dialog: window.print becomes a recorder.
  await page.evaluate(() => {
    window.printCalls = 0;
    window.print = () => { window.printCalls++; };
  });
  await reprint.getByTestId('order-receipt-print').click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  // What the dialog would print: the receipt alone, none of the orders panel or sheet around it.
  await page.emulateMedia({ media: 'print' });
  await expect(reprint).toBeVisible();
  for (const id of ['order-sheet-close', 'order-receipt-print', 'order-receipt-back']) {
    await expect(page.getByTestId(id)).toBeHidden();
  }
  await page.emulateMedia({ media: 'screen' });

  await reprint.getByTestId('order-receipt-back').click();
  await expect(page.getByTestId('order-sheet-detail')).toBeVisible();

  // A seeded order reprints too.
  await page.getByTestId('order-sheet-close').click();
  await (await storeRows(page)).filter({ hasText: 'DEMO-000002' }).click();
  await page.getByTestId('order-sheet-receipt').click();
  await expect(page.getByTestId('order-receipt').getByTestId('order-receipt-total')).toHaveText('€23.52');
});

test("Reports shows the till's sale for today, and a scan closes it and adds", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('receipt').getByTestId('new-sale').click();

  await page.getByTestId('reports-open').click();
  await expect(page.getByTestId('reports-panel')).toBeVisible();
  await expect(page.getByTestId('hero-total')).toContainText('€9.52');
  await expect(page.getByTestId('card-orders-figure')).toHaveText('1');
  await expect(page.getByTestId('hero-median')).toHaveText('€9.52');
  await expect(page.getByTestId('hero-largest')).toHaveText('€9.52');
  await page.getByTestId('reports-print-summary').click();
  const summary = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(summary.slice(0, 1)).toEqual(['Sales summary']);
  expect(summary).toEqual(expect.arrayContaining(['Total €9.52', 'Orders 1', 'Items 1', 'Payments']));
  await expect(page.getByTestId('reports-print-error')).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('reports-export-csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^sales-summary-(\d{4}-\d{2}-\d{2})-\1\.csv$/);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  expect(csv.startsWith('"Section","Name","Quantity","Amount"')).toBe(true);
  expect(csv).toContain('"Summary","Total","","9.52"');
  expect(csv).toContain('"Products","Tally Fixture Mug","1",');
  await expect(page.getByTestId('reports-export-error')).toHaveCount(0);
  // The demo-pairs size, as 10d; the PNG is made docs/v2-parity/demo-pairs/10e-reports-export-vendurepos.webp (cwebp -q 80).
  await page.setViewportSize({ width: 960, height: 600 });
  await page.getByTestId('reports-export-csv').scrollIntoViewIfNeeded();
  await page.mouse.move(480, 0);
  await page.screenshot({ path: test.info().outputPath('10e-reports-export-vendurepos.png') });
  await page.setViewportSize(devices['Desktop Chrome'].viewport);
  await expect(page.getByTestId('reports-close')).toHaveCount(0);
  await expect(page.getByTestId('reports-panel')).not.toContainText('Back to sale');
  await expect(page.getByTestId('sales-hero')).not.toContainText('—');
  await expect(page.getByTestId('hero-compare')).toHaveCount(1);
  await expect(page.getByTestId('hero-compare')).toContainText('vs yesterday');
  await page.getByTestId('hero-compare').click();
  await expect(page.getByTestId('hero-compare')).toHaveText(/vs last \w+day/);
  await expect(page.getByTestId('hero-chart').locator('[data-testid^="hero-hour-bar-"]')).toHaveCount(24);
  await page.getByTestId('reports-open').click();
  await expect(page.getByTestId('reports-panel')).toHaveCount(0);
  await page.getByTestId('reports-open').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await wedgeScan(page, 'TALLY-MUG');
  await expect(page.getByTestId('reports-panel')).toHaveCount(0);
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
});

test('Reports opens on the drawer card: since, float + cash sales = expected, Print X-report and the register panel', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('receipt').getByTestId('new-sale').click();

  await page.getByTestId('reports-open').click();
  const drawer = page.getByTestId('reports-drawer');
  await expect(drawer.getByTestId('reports-drawer-status')).toHaveText(/^Register · Open since \d{2}:\d{2} · .+$/);
  await expect(drawer.getByTestId('reports-drawer-float')).toHaveText('Opening float €100.00');
  await expect(drawer.getByTestId('reports-drawer-cash-sales')).toHaveText('Cash sales · 1 €9.52');
  await expect(drawer.getByTestId('reports-drawer-expected')).toHaveText('Expected in drawer €109.52');

  await drawer.getByTestId('reports-drawer-print-x').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed).toEqual(expect.arrayContaining(['X report · Register open', 'Opening float €100.00']));
  await expect(drawer.getByTestId('reports-drawer-print-error')).toHaveCount(0);

  await drawer.getByTestId('reports-drawer-open-register').click();
  await expect(page.getByTestId('register-panel')).toBeVisible();
});

test('a demo cashier refunds a mug from the order sheet; stock comes back and expected cash drops', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  // Two mugs, €8.00 + 19 % = €9.52 each, paid in cash.
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€19.04');
  await typeAmount(page, '19.04');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('receipt').getByTestId('new-sale').click();
  const sold = await mugStock(page);

  await page.getByTestId('orders-open').click();
  await page.getByTestId('orders-scope-till').click();
  const panel = page.getByTestId('orders-panel');
  await expect(panel.getByText(/· Synced$/)).toHaveCount(1);
  await panel.getByTestId(/^order-open-/).first().click();
  const sheet = page.getByTestId('refund-sheet');
  const refundOneMug = async () => {
    await sheet.getByTestId(/^refund-qty-/).first().fill('1');
    await sheet.getByTestId('refund-reason').fill('Damaged');
    await expect(sheet.getByTestId('refund-total')).toHaveText('Refund €9.52');
    await sheet.getByTestId('refund-submit').click();
    await expect(sheet.getByTestId('refund-message')).toHaveText('Refunded €9.52 to the original payment.');
  };
  await sheet.getByTestId('refund-start').click();
  await refundOneMug();
  expect(sold).toBe(MUG_SEED_STOCK - 2);
  await expect.poll(() => mugStock(page)).toBe(MUG_SEED_STOCK - 1);

  // The sheet re-read the order: one mug is left, and refunding it leaves nothing to refund.
  await sheet.getByTestId('refund-start').click();
  await expect(sheet.getByTestId('refund-form')).toContainText('1 left to refund');
  await refundOneMug();
  await expect(sheet.getByTestId('refund-start')).toHaveCount(0);

  // €100.00 float + €19.04 cash sale − €19.04 cash refunded.
  await page.getByTestId('orders-open').click();
  await page.getByTestId('register-open-panel').click();
  await expect(page.getByTestId('register-panel').getByTestId('register-panel-expected')).toContainText('€100.00');
});

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
  // The whole seed is on the till: the In Stock pill (on by default) is tapped off to show the shelf's sold-out products too.
  await page.getByTestId('filter-chip-inStock').click();
  for (const { name } of CATALOGUE) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  expect(CATALOGUE).toHaveLength(30);

  // A sale: the register opened with €100.00, 2 × mug for cash, €8.00 × 2 + 19 % = €19.04.
  await openRegister(page);
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender-pane');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const line = cart.getByTestId('cart-line-TALLY-MUG');
  await expect(line).toBeVisible();
  const inCart = page.getByTestId(`in-cart-${MUG_PRODUCT_ID}`);
  await expect(inCart).toHaveText('1');
  await line.getByTestId('quantity-popover-trigger').click();
  await page.getByTestId('quantity-popover-keypad-key-2').click();
  await page.getByTestId('quantity-popover-apply').click();
  await expect(inCart).toHaveText('2');
  await checkout(page);
  await expect(tender.getByTestId('tender-balance')).toContainText('€19.04');
  await typeAmount(page, '19.04');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt').getByTestId('receipt-total')).toContainText('€19.04');
  const reference = (await page.getByTestId('receipt-order').innerText()).match(/^Order (\S+)/)![1];
  expect(reference).toHaveLength(8);
  await page.getByTestId('new-sale').click();

  // Settled: synced in the Orders panel, nothing pending and nothing needing attention.
  const entries = await orderEntries(page);
  await expect(entries).toHaveText([/€19\.04 · Synced$/]);
  await expect(page.getByTestId('orders-panel').getByText('Needs attention', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('sync-status')).toHaveCount(0);
  await expect(page.getByTestId('orders-rejected')).toHaveCount(0);
  await expect(page.getByTestId('orders-panel')).toContainText(reference);
  // The store table also lists this sale, newest first as order 4; its store code differs from the local receipt reference.
  await expect(await storeRows(page)).toHaveText([/DEMO-000004/, ...SEEDED_ORDERS]);
  await page.getByTestId('orders-open').click();
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
  await page.getByTestId('orders-open').click();
  // Three historic orders are seeded on the simulated server.
  expect((await demoState(page))!.orders).toHaveLength(4);
  expect(await mugStock(page)).toBe(MUG_SEED_STOCK - 2);
  await expect(page.getByTestId('open-register-card')).toBeVisible();
  await expect(page.getByTestId('register-open-panel')).toHaveCount(0);

  // Nothing left the page's own origin, and nothing broke the CSP.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => new URL(url).origin !== origin && url !== DEMO_CAPTURE_URL)).toEqual([]);
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
  await expect(page.getByTestId('signed-in-store')).toHaveCount(0);
  await page.getByTestId('tab-cart').click();
  await page.getByTestId('open-register-amount').fill('100.00');
  await page.getByTestId('open-register-button').click();
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The v2 frame: Sign out is in the cashier sheet and Settings in the drawer, each one tap behind the bar.
  await expect(page.getByTestId('register-bar-cashier')).toBeInViewport();
  await expect(page.getByTestId('register-bar-menu')).toBeInViewport();
  await page.getByTestId('register-bar-cashier').click();
  await expect(page.getByTestId('sign-out')).toBeInViewport();
  await expect(page.getByTestId('sign-out')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cashier-sheet')).toHaveCount(0);
  await page.getByTestId('register-bar-menu').click();
  await expect(page.getByTestId('settings-open')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toBeInViewport();
  await page.getByTestId('register-open-panel').click();
  await expect(page.getByTestId('register-panel-dismiss')).toBeInViewport();
  await page.getByTestId('register-panel-dismiss').click();
  await expect(page.getByTestId('register-panel')).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => new URL(url).origin !== origin && url !== DEMO_CAPTURE_URL)).toEqual([]);
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
  await openSettings(page, 'barcode');
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
  await openSettings(page, 'barcode');
  await page.reload();
  await openSettings(page, 'barcode');
  await expect(page.getByTestId('scanner-min-length')).toHaveValue('5');
  await expect(page.getByTestId('settings-barcode-field')).toContainText('Barcode custom field:');
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('signed-in-store')).toBeVisible();
  await expect(page.getByTestId('signed-in-store')).toHaveCount(1);
  await expect(page.getByTestId('open-register-card').getByTestId('open-register-amount')).toBeEditable();
});

test('Settings shows one section at a time, General first, and stacks behind Menu at phone width', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expect(page.getByTestId('signed-in-store')).toBeVisible();
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('settings-section-general')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tile-size-auto')).toBeVisible();
  await expect(page.getByTestId('price-edit-toggle')).toHaveAttribute('role', 'switch');
  await expect(page.getByTestId('price-edit-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('price-edit-toggle').click();
  await expect(page.getByTestId('price-edit-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('price-edit-toggle').click();
  await expect(page.getByTestId('price-edit-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('scanner-min-length')).toHaveCount(0);
  await expect(page.getByTestId('variance-limit')).toHaveCount(0);
  await page.getByTestId('settings-section-register').click();
  await expect(page.getByTestId('variance-limit')).toBeVisible();
  await expect(page.getByTestId('tile-size-auto')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('variance-limit')).toBeVisible();
  await expect(page.getByTestId('settings-section-general')).toHaveCount(0);
  await page.getByText('Menu', { exact: true }).click();
  await page.getByTestId('settings-section-barcode').click();
  await page.getByText('Done', { exact: true }).click();
  await expect(page.getByTestId('scanner-min-length')).toBeVisible();
});

test('Settings keeps the tile size for this till, and the grid takes it at once', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'general');
  await expect(page.getByTestId('tile-size-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tile-size-3').click();
  await expect(page.getByTestId('tile-size-3')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-back').click();

  const tiles = page.locator('[data-testid^="product-tile-"]');
  for (const reload of [false, true]) {
    if (reload) {
      await page.reload();
      await expectSignedIn(page);
    }
    await expect(tiles.nth(3)).toBeVisible();
    await expect(async () => {
      const first = await tiles.nth(0).boundingBox();
      const second = await tiles.nth(1).boundingBox();
      const third = await tiles.nth(2).boundingBox();
      const fourth = await tiles.nth(3).boundingBox();
      expect(first).not.toBeNull();
      expect(second?.y).toBe(first!.y);
      expect(third?.y).toBe(first!.y);
      expect(fourth?.y).toBeGreaterThan(first!.y);
    }).toPass();
  }

  await openSettings(page, 'general');
  await page.getByTestId('tile-size-auto').click();
  await page.getByTestId('settings-back').click();
  await expect(tiles.nth(3)).toBeVisible();
  await expect(async () => {
    const first = await tiles.nth(0).boundingBox();
    const fourth = await tiles.nth(3).boundingBox();
    expect(first).not.toBeNull();
    expect(fourth?.y).toBe(first!.y);
  }).toPass();
});

test('Settings keeps the product sort for this till, and the grid takes it on return', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const firstTile = page.locator('[data-testid^="product-tile-"]').first();
  await expect(firstTile).toHaveAttribute('data-testid', 'product-tile-Canvas Apron');
  await openSettings(page, 'general');
  await expect(page.getByTestId('product-sort-name-asc')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('product-sort-price-desc').click();
  await expect(page.getByTestId('product-sort-price-desc')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-back').click();
  // The demo store's dearest product: the hoodie at €49.99.
  await expect(firstTile).toHaveAttribute('data-testid', 'product-tile-Tally Hoodie');
  await openSettings(page, 'general');
  await page.getByTestId('product-sort-name-asc').click();
  await page.getByTestId('settings-back').click();
  await expect(firstTile).toHaveAttribute('data-testid', 'product-tile-Canvas Apron');
});

test('Settings › General puts the cart on the left or the right of the till', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const cartLeft = async () => {
    const cart = await page.getByTestId('till-cart').boundingBox();
    const catalogue = await page.getByTestId('till-catalogue').boundingBox();
    return cart && catalogue ? cart.x < catalogue.x : null;
  };
  await expect.poll(cartLeft).toBe(false);
  await openSettings(page, 'general');
  await expect(page.getByTestId('cart-side-right')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('cart-side-left').click();
  await expect(page.getByTestId('cart-side-left')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(cartLeft).toBe(true);
  await openSettings(page, 'general');
  await page.getByTestId('cart-side-right').click();
  await page.getByTestId('settings-back').click();
  await expect.poll(cartLeft).toBe(false);
});

test('Settings › General picks the register this device is at, and the till follows it', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const bound = () => page.evaluate(() => localStorage.getItem('vendurepos.bound_register_id'));
  const own = await bound();
  expect(own).toBeTruthy();
  await openSettings(page, 'general');
  const choices = page.getByRole('radiogroup', { name: 'Which register is this device at?' });
  await expect(choices.getByRole('radio')).toHaveCount(2);
  await expect(choices.getByRole('radio', { name: /This device/ })).toBeChecked();
  await expect(page.getByTestId('register-choice-own')).toContainText('This device');
  await expect(page.getByTestId('register-choice-own')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('register-choice-demo-front-counter')).toContainText('Front counter');
  await page.getByTestId('register-choice-demo-front-counter').click();
  await expect(page.getByTestId('register-choice-demo-front-counter')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(bound).toBe('demo-front-counter');
  // Front counter has no session: the till offers to open it.
  await expect(page.getByTestId('open-register-card')).toBeVisible();
  await openSettings(page, 'general');
  await page.getByTestId('register-choice-own').click();
  await expect(page.getByTestId('register-choice-own')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(bound).toBe(own);
  await openSettings(page, 'general');
  await page.getByTestId('register-choice-demo-front-counter').click();
  await page.getByTestId('settings-back').click();
  await expect.poll(bound).toBe('demo-front-counter');
  // The till opens the register it is now bound to.
  await openRegister(page);
  // The picker reads the register list once, when Settings opens: wait until the store holds the open session.
  await expect.poll(async () => Object.values((await demoState(page))?.sessions ?? {}).some((s) => s.registerId === 'demo-front-counter' && s.status === 'open')).toBe(true);
  await openSettings(page, 'general');
  await expect(page.getByTestId('register-choice-demo-front-counter-status')).toContainText('Open since');
  await expect(page.getByTestId('register-choice-own-status')).toHaveCount(0);
  // A live session holds the till to its register.
  await page.getByTestId('register-choice-own').click();
  await expect(page.getByTestId('register-choice-refused')).toHaveText('Close the register first');
  await expect(page.getByTestId('register-choice-demo-front-counter')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(bound).toBe('demo-front-counter');
});

test('a counting register holds the till to it until it is closed', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('register-open-panel').click();
  await page.getByTestId('register-panel-close').click();
  await expect(page.getByTestId('count-amount')).toBeVisible();
  await openSettings(page, 'general');
  await page.getByTestId('register-choice-demo-front-counter').click();
  await expect(page.getByTestId('register-choice-refused')).toHaveText('Close the register first');
  await expect(page.getByTestId('register-choice-own')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vendurepos.bound_register_id'))).not.toBe('demo-front-counter');
});

test('the register panel names the register the till is at', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'general');
  await page.getByTestId('register-choice-demo-front-counter').click();
  await page.getByTestId('settings-back').click();
  await openRegister(page);
  await page.getByTestId('register-open-panel').click();
  await expect(page.getByTestId('register-panel-title')).toHaveText('Front counter');
});

test("the sync log in Settings keeps a till update's outcome, never its figures", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page, '10.00');
  await openSettings(page, 'sync-log');
  const log = page.getByTestId('sync-log');
  await expect(log.getByTestId('sync-log-entry').filter({ hasText: 'Register command result' }).first()).toContainText('status=applied');
  // The open's result carries the session's expected cash, which a blind count hides from the cashier.
  await expect(log).not.toContainText('expected');
  await page.getByTestId('sync-log-filter-problems').click();
  await expect(log.getByTestId('sync-log-entry').filter({ hasText: 'Register command result' })).toHaveCount(0);
  await page.getByTestId('sync-log-filter-all').click();
  await expect(log.getByTestId('sync-log-entry').first()).toBeVisible();
});

test("over the till's limit, a close needs a typed approver, recorded as typed", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'register');
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

  await openSettings(page, 'register');
  await page.getByTestId('variance-limit').fill('');
  await page.getByTestId('variance-save').click();
  await expect(page.getByTestId('variance-saved')).toBeVisible();
  await page.getByTestId('settings-back').click();
});

test('a Close by time in the past makes the open register overdue, and its Close register starts the count', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'register');
  await page.getByTestId('close-by-time').fill('0:00');
  await page.getByTestId('close-by-save').click();
  await expect(page.getByTestId('close-by-saved')).toBeVisible();
  await expect(page.getByTestId('close-by-time')).toHaveValue('00:00');
  await page.getByTestId('settings-back').click();
  await openRegister(page);
  await expect(page.getByTestId('register-column-overdue')).toContainText('This register is overdue for closing.');
  await expect(page.getByTestId('register-bar-pill')).toHaveText('Overdue');
  await page.setViewportSize({ width: 960, height: 600 });
  await page.mouse.move(480, 0);
  await page.screenshot({ path: test.info().outputPath('09f-register-overdue-vendurepos.png') });
  await page.setViewportSize(devices['Desktop Chrome'].viewport);
  await page.getByTestId('register-column-close-overdue').click();
  await expect(page.getByTestId('register-count')).toBeVisible();
});

test('an opening float set in Settings prefills Open register and offers it as a chip', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'register');
  await page.getByTestId('opening-float').fill('150');
  await page.getByTestId('opening-float-save').click();
  await expect(page.getByTestId('opening-float-saved')).toBeVisible();
  await expect(page.getByTestId('opening-float')).toHaveValue('150.00');
  await page.getByTestId('settings-back').click();

  const card = page.getByTestId('open-register-card');
  await expect(card.getByTestId('open-register-amount')).toHaveValue('150.00');
  await expect(card.getByTestId('open-register-chip-configured')).toContainText('150.00');
  await page.setViewportSize({ width: 960, height: 600 });
  await page.mouse.move(480, 0);
  await page.screenshot({ path: test.info().outputPath('09g-register-open-float-vendurepos.png') });
  await page.setViewportSize(devices['Desktop Chrome'].viewport);
  await card.getByTestId('open-register-amount').fill('90.00');
  await expect(card.getByTestId('opening-variance')).toBeVisible();
  await card.getByTestId('open-register-chip-configured').click();
  await expect(card.getByTestId('open-register-amount')).toHaveValue('150.00');
  await expect(card.getByTestId('opening-variance')).toHaveCount(0);

  await openSettings(page, 'register');
  await page.getByTestId('opening-float').fill('');
  await page.getByTestId('opening-float-save').click();
  await expect(page.getByTestId('opening-float-saved')).toBeVisible();
  await page.getByTestId('settings-back').click();
});

test('a demo till prints an X report mid-shift and stays open', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  // v2 prints the X report from the register panel's footer (parity 6.2).
  await page.getByTestId('register-open-panel').click();
  const panel = page.getByTestId('register-panel');
  await panel.getByTestId('register-panel-print').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed).toEqual(expect.arrayContaining([
    'X report · Register open', 'Sales 0', 'Opening float €100.00', 'Cash expected €100.00',
  ]));
  await expect(panel.getByTestId('register-panel-print-error')).toHaveCount(0);
  await panel.getByTestId('register-panel-dismiss').click();
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
});

test("the register panel is v2's side sheet: store and session age, the drawer hero, other tenders and Print X-report", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  // One mug by card, €8.00 + 19 % = €9.52.
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  await page.getByTestId('tender-method-external').click();
  await takePayment(page);
  await page.getByTestId('tender-pane').getByTestId('tender-complete').click();
  await page.getByTestId('new-sale').click();

  await page.getByTestId('register-open-panel').click();
  const panel = page.getByTestId('register-panel');
  await expect(panel.getByTestId('register-panel-title')).toHaveText('Register');
  const description = panel.getByTestId('register-panel-description');
  await expect(description).toHaveText(/· open since \d{1,2}:\d{2} · \d+ m · Cashier$/);
  // lib/demo/fetch.ts's DEMO_STORE_NAME (see DEMO_STORE_ORIGIN above for why it is not imported).
  await expect(description).toContainText('VendurePOS demo store');
  await expect(panel.getByTestId('register-panel-hero')).toContainText('€100.00');
  await expect(panel.getByTestId('register-panel-hero')).toContainText('in the drawer');
  await expect(panel.getByTestId('register-panel-session-sales')).toContainText('1 sale');
  await expect(panel.getByTestId('register-panel-other-tenders')).toBeVisible();
  await expect(panel.getByTestId('register-panel-other-tenders')).toContainText('€9.52');
  await expect(panel.getByTestId('register-panel-print')).toBeVisible();
  await expect(panel.getByTestId('register-panel-footer').getByTestId('register-panel-close')).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  // Again after the register list has answered (a few hundred ms after the panel opens): the till's own register has no device name, so never the "Register 1a2b3c4d" id fallback (CHECKLIST 6.6c).
  await page.waitForTimeout(1500);
  await expect(panel.getByTestId('register-panel-title')).toHaveText('Register');
  await panel.getByTestId('register-panel-dismiss').click();

  // The cashier sheet no longer has an X report: v2's avatar sheet has none.
  await page.getByTestId('register-bar-cashier').click();
  await expect(page.getByTestId('cashier-sheet')).toBeVisible();
  await expect(page.getByTestId('register-print-x')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cashier-sheet')).toHaveCount(0);
});

test('the cashier sheet shows the register and since in its header, your sales today and the drawer, Pay in and Close register', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('receipt').getByTestId('new-sale').click();

  await page.getByTestId('register-bar-cashier').click();
  const sheet = page.getByTestId('cashier-sheet');
  await expect(sheet.getByTestId('cashier-shift-since')).toHaveText(/^Register · open since \d{2}:\d{2}$/);
  await expect(sheet.getByTestId('cashier-shift-sales-today')).toHaveText('€9.52');
  await expect(sheet.getByTestId('cashier-shift-drawer')).toHaveText('€109.52');

  await sheet.getByTestId('cashier-shift-pay-in').click();
  const movement = page.getByTestId('movement-sheet');
  await movement.getByTestId('movement-amount').fill('5.00');
  await movement.getByTestId('movement-reason').fill('Change');
  await movement.getByTestId('movement-confirm').click();
  await expect(movement).toHaveCount(0);
  await expect(sheet.getByTestId('cashier-shift-drawer')).toHaveText('€114.52');
  await expect(sheet.getByTestId('cashier-shift-sales-today')).toHaveText('€9.52');

  await sheet.getByTestId('cashier-shift-close-register').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('register-count')).toBeVisible();
});

test('Hand over in the cashier sheet signs this account out and leaves the register open for the next', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  await page.getByTestId('register-bar-cashier').click();
  const sheet = page.getByTestId('cashier-sheet');
  await sheet.getByTestId('hand-over').click();
  const confirm = page.getByTestId('switch-confirm');
  await expect(confirm.getByTestId('switch-confirm-title')).toHaveText('Hand the till to another account?');
  await expect(confirm.getByTestId('switch-confirm-description')).toHaveText('The drawer stays open on Register.');
  await expect(confirm.getByTestId('switch-confirm-warnings')).toHaveCount(0);
  await expect(confirm.getByTestId('switch-confirm-handover')).toBeVisible();

  await confirm.getByTestId('switch-confirm-confirm').click();
  await expect(page.getByTestId('demo-enter')).toBeVisible();
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await expect(page.getByTestId('open-register-card')).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
});

test('the cashier sheet and the hand-over name the register the till is at', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'general');
  await page.getByTestId('register-choice-demo-front-counter').click();
  await page.getByTestId('settings-back').click();
  await openRegister(page);

  await page.getByTestId('register-bar-cashier').click();
  const sheet = page.getByTestId('cashier-sheet');
  await expect(sheet.getByTestId('cashier-shift-since')).toHaveText(/^Front counter · open since \d{2}:\d{2}$/);
  await sheet.getByTestId('hand-over').click();
  const confirm = page.getByTestId('switch-confirm');
  await expect(confirm.getByTestId('switch-confirm-description')).toHaveText('The drawer stays open on Front counter.');

  await confirm.getByTestId('switch-confirm-handover').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed[0]).toBe('Hand-over slip');
  expect(printed[2]).toMatch(/^Front counter · open since \d{2}:\d{2}/);
});

test('a closed till lists its closures and reprints a Z as a copy', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  await page.getByTestId('register-open-panel').click();
  await page.getByTestId('register-panel-close').click();
  await page.getByTestId('count-amount').fill('100.00');
  await page.getByTestId('count-close').click();
  await page.getByTestId('closure-sheet').getByTestId('closure-done').click();
  await page.getByTestId('register-bar-cashier').click();
  await page.getByTestId('closure-history-open').click();
  const history = page.getByTestId('closure-history');
  await expect(history.getByTestId('closure-history-row-1')).toContainText('This device · Closure #1');
  await expect(history.getByTestId('closure-history-row-1')).toContainText('Sales €0.00 · Cash at open €100.00 · Cash at close €100.00 · Exact');
  // The demo's Front counter closed yesterday (lib/demo/store.ts seededClosure); the server read carries the session's float.
  const front = history.getByTestId('closure-history-row-demo-front-counter-1');
  await expect(front).toContainText('Front counter · Closure #1');
  await expect(front).toContainText('Sales €245.50 · Cash at open €120.00 · Cash at close €150.00 · Exact');
  await expect(history.getByTestId('closure-history-remote-error')).toHaveCount(0);
  // The demo-pairs size, as 13f; the PNG is made docs/v2-parity/demo-pairs/10c-closures-all-registers-vendurepos.webp (cwebp -q 80).
  await page.setViewportSize({ width: 960, height: 600 });
  await page.mouse.move(480, 0);
  await page.screenshot({ path: test.info().outputPath('10c-closures-all-registers-vendurepos.png') });
  await page.setViewportSize(devices['Desktop Chrome'].viewport);
  await history.getByTestId('closure-history-print-1').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed[0]).toBe('Z report · Closure #1');
  expect(printed[1]).toMatch(/^Copy · printed /);
  expect(printed).toEqual(expect.arrayContaining(['Opening float €100.00', 'Cash expected €100.00', 'Cash counted €100.00']));
  await expect(history.getByTestId('closure-history-print-error')).toHaveCount(0);
  // The Front counter's Z copy, from a server read that carries the opening float and still has no sales count.
  await history.getByTestId('closure-history-print-demo-front-counter-1').click();
  const frontPrint = page.frameLocator('#vendurepos-print').locator('p');
  await expect(frontPrint.filter({ hasText: 'Sales total €245.50' })).toHaveCount(1);
  const frontPrinted = await frontPrint.allTextContents();
  expect(frontPrinted[0]).toBe('Z report · Closure #1');
  expect(frontPrinted).toEqual(expect.arrayContaining(['Sales total €245.50', 'Cash counted €150.00', 'Opening float €120.00']));
  expect(frontPrinted.filter((line) => line.includes('undefined'))).toEqual([]);
  const [download] = await Promise.all([page.waitForEvent('download'), history.getByTestId('closure-history-export').click()]);
  // Yesterday's Front counter closure to today's own one.
  const fileName = /^closures-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.csv$/;
  expect(download.suggestedFilename()).toMatch(fileName);
  const [, from, to] = fileName.exec(download.suggestedFilename())!;
  expect(from < to).toBe(true);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  expect(csv.startsWith('"Business day","Closure","Register","Store","Opened","Closed","Closed by",')).toBe(true);
  expect(csv).toContain('"100.00","100.00","0.00 Exact"');
  expect(csv).toContain('"Front counter"');
  await history.getByTestId('closure-history-close').click();
  await expect(page.getByTestId('closure-history')).toHaveCount(0);
});

test("Reports › Closures lists every register's closures and opens one to its Z report", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  await page.getByTestId('register-open-panel').click();
  await page.getByTestId('register-panel-close').click();
  await page.getByTestId('count-amount').fill('100.00');
  await page.getByTestId('count-close').click();
  await page.getByTestId('closure-sheet').getByTestId('closure-done').click();
  // Open the register again, so the Closures view has an open session beside the two closures.
  await card.getByTestId('open-register-amount').fill('50.00');
  await card.getByTestId('open-register-button').click();
  await page.getByTestId('reports-open').click();
  const panel = page.getByTestId('reports-panel');
  await panel.getByTestId('reports-tab-closures').click();
  await expect(panel.getByTestId('closure-history-row-1')).toContainText('This device · Closure #1');
  await expect(panel.getByTestId('closure-history-row-demo-front-counter-1')).toContainText('Front counter · Closure #1');
  // v2's tiles: this device's open session and closure #1 (€100.00 counted), and Front counter's closure yesterday (€150.00).
  await expect(panel.getByTestId('closures-tile-sessions')).toContainText('3');
  await expect(panel.getByTestId('closures-tile-sessions')).toContainText('1 open · 2 closed');
  await expect(panel.getByTestId('closures-tile-cash-at-close')).toContainText('€250.00');
  await expect(panel.getByTestId('closures-tile-discrepancy')).toContainText('€0.00');
  // Floats: the open session's €50, closure #1's €100 and Front counter's €120; activity (100 − 100) + (150 − 120).
  await expect(panel.getByTestId('closures-tile-cash-at-open')).toContainText('€270.00');
  await expect(panel.getByTestId('closures-tile-cash-activity')).toContainText('+€30.00');
  const openRow = panel.locator('[data-testid^="closures-open-"]').first();
  await expect(openRow).toContainText('This device · Open since');
  await expect(panel.locator('[data-testid^="closures-open-print-x-"]')).toHaveCount(0);
  const days = panel.locator('[data-testid^="closures-day-"]');
  await expect(days.first()).toContainText('Today');
  await expect(days.first().getByTestId('closure-history-row-1')).toBeVisible();
  await expect(days.nth(1)).toContainText('Yesterday');
  await expect(days.nth(1).getByTestId('closure-history-row-demo-front-counter-1')).toBeVisible();
  await panel.getByTestId('closures-filter-open').click();
  await expect(openRow).toBeVisible();
  await expect(panel.getByTestId('closure-history-row-1')).toHaveCount(0);
  await panel.getByTestId('closures-filter-closed').click();
  await expect(panel.locator('[data-testid^="closures-open-"]')).toHaveCount(0);
  await expect(panel.getByTestId('closure-history-row-1')).toBeVisible();
  await panel.getByTestId('closures-filter-all').click();
  await expect(openRow).toBeVisible();
  // The demo-pairs size, as 10c; the PNG is made docs/v2-parity/demo-pairs/10d-reports-closures-vendurepos.webp (cwebp -q 80).
  await page.setViewportSize({ width: 960, height: 600 });
  await page.mouse.move(480, 0);
  await page.screenshot({ path: test.info().outputPath('10d-reports-closures-vendurepos.png') });
  await page.setViewportSize(devices['Desktop Chrome'].viewport);
  await panel.getByTestId('closure-history-open-demo-front-counter-1').click();
  await expect(panel.getByTestId('closure-detail-title')).toHaveText('Front counter · Closure #1');
  await expect(panel.getByTestId('closure-detail')).toContainText('Sales total €245.50');
  await expect(panel.getByTestId('closure-detail')).toContainText('Cash counted €150.00');
  await panel.getByTestId('closure-detail-back').click();
  await expect(panel.getByTestId('closure-history-row-1')).toBeVisible();
  await panel.getByTestId('reports-tab-sales').click();
  await expect(panel.getByTestId('sales-room')).toBeVisible();
});

test('a demo visitor attaches a customer and sees it on the receipt', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('customer-chip').click();
  await page.getByLabel('Search customers').fill('ada');
  await page.getByTestId('customer-picker').getByText('Ada Lovelace', { exact: true }).click();
  await expect(page.getByTestId('sale-customer')).toContainText('Ada Lovelace');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt-customer')).toHaveText('Customer: Ada Lovelace');
  expect(consoleErrors).toEqual([]);
});

test('a default customer starts each new sale and can be removed from one', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'general');
  await expect(page.getByTestId('default-customer')).toHaveText('Default customer: none (guest sales)');
  await page.getByTestId('default-customer-choose').click();
  const picker = page.getByTestId('default-customer-picker');
  await picker.getByLabel('Search customers').fill('ada');
  await picker.getByText('Ada Lovelace', { exact: true }).click();
  await expect(page.getByTestId('default-customer')).toContainText('Ada Lovelace');
  await page.reload();
  await openSettings(page, 'general');
  await expect(page.getByTestId('default-customer')).toContainText('Ada Lovelace');
  await page.getByTestId('settings-back').click();
  await openRegister(page);
  await expect(page.getByTestId('sale-customer')).toHaveText('Ada Lovelace');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt-customer')).toHaveText('Customer: Ada Lovelace');
  await page.getByTestId('new-sale').click();
  await expect(page.getByTestId('sale-customer')).toHaveText('Ada Lovelace');
  await page.getByTestId('customer-remove').click();
  await expect(page.getByTestId('sale-customer')).toHaveCount(0);
  await expect(page.getByTestId('customer-chip')).toContainText('Guest');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(page.getByTestId('sale-customer')).toHaveCount(0);
  await checkout(page);
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt')).toBeVisible();
  await expect(page.getByTestId('receipt-customer')).toHaveCount(0);
  await openSettings(page, 'general');
  await page.getByTestId('default-customer-clear').click();
  await expect(page.getByTestId('default-customer')).toHaveText('Default customer: none (guest sales)');
  await page.getByTestId('settings-back').click();
});

test("a demo cashier sees Guest in the cart's customer chip and a toast when an item is added", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await expect(page.getByTestId('customer-row')).toContainText('Customer');
  await expect(page.getByTestId('customer-chip')).toContainText('Guest');

  // The mug's cart line is named as the product.
  const toast = page.getByTestId('add-toast');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
  await expect(page.getByTestId('cart').getByTestId('cart-paid')).toHaveCount(0);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText('Tally Fixture Mug added to cart');
  await expect(toast).toBeHidden({ timeout: 5000 });

  // One more on the same line toasts too.
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(toast).toBeVisible();
});

test('the ⋮ beside Checkout opens Order details, and Void drops the sale', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const cart = page.getByTestId('cart');
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await page.getByTestId('order-details-open').click();
  await expect(page.getByTestId('order-details')).toBeVisible();
  await expect(page.getByTestId('order-details')).toContainText('Order details');
  await page.getByTestId('order-details-close').click();
  await expect(page.getByTestId('order-details')).toHaveCount(0);
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await page.getByTestId('order-details-open').click();
  await page.getByTestId('order-details-void').click();
  await expect(page.getByTestId('order-details')).toHaveCount(0);
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);
  await expect(page.getByTestId('cart-total')).toHaveText('€0.00');
  await expect(page.getByTestId('order-details-error')).toHaveCount(0);
});

test('Order details keeps a customer note on the sale and sends it to the store with the order', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(page.getByTestId('cart').getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await page.getByTestId('order-details-open').click();
  await expect(page.getByTestId('order-details')).toContainText('Customer note');
  await page.getByTestId('order-details-note').fill('Gift wrap, please');
  await page.getByTestId('order-details-close').click();
  await expect(page.getByTestId('order-details')).toHaveCount(0);
  await page.getByTestId('order-details-open').click();
  await expect(page.getByTestId('order-details-note')).toHaveValue('Gift wrap, please');
  await page.getByTestId('order-details-close').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-balance')).toContainText('€9.52');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect.poll(async () => ((await demoState(page))?.orders.at(-1) as { note?: string } | undefined)?.note).toBe('Gift wrap, please');
  await page.getByTestId('receipt').getByTestId('new-sale').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('order-details-open').click();
  await expect(page.getByTestId('order-details-note')).toHaveValue('');
});

test('the till follows the device\'s dark scheme and prints its receipt in light', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const shell = page.getByTestId('app-shell');
  const html = page.locator('html');
  await expect(shell).toHaveCSS('background-color', 'rgb(13, 17, 23)');
  await expect(html).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(shell).toHaveCSS('background-color', 'rgb(248, 249, 250)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(shell).toHaveCSS('background-color', 'rgb(13, 17, 23)');

  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(html).toHaveClass(/\blight\b/);
  await expect(shell).toHaveCSS('background-color', 'rgb(248, 249, 250)');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(shell).toHaveCSS('background-color', 'rgb(13, 17, 23)');
});

test('Settings › Theme chooses Light or Dark over the device\'s scheme, and keeps it after a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const html = page.locator('html');
  await openSettings(page, 'theme');
  await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.getByTestId('theme-dark').click();
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
  await expect(html).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await openSettings(page, 'theme');
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('theme-light').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.getByTestId('theme-system').click();
  await expect(html).toHaveClass(/\bdark\b/);
});

test('Settings › Theme sets the scale, and keeps it after a reload', async ({ page }) => {
  const textBase = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-base').trim());
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'theme');
  await expect(page.getByTestId('scale-auto')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(textBase).toBe('14px');
  await page.getByTestId('scale-compact').click();
  await expect.poll(textBase).toBe('13px');
  await page.getByTestId('scale-spacious').click();
  await expect(page.getByTestId('scale-spacious')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(textBase).toBe('16px');
  await page.reload();
  await openSettings(page, 'theme');
  await expect(page.getByTestId('scale-spacious')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(textBase).toBe('16px');
  await page.getByTestId('scale-auto').click();
  await expect.poll(textBase).toBe('14px');
});

test("Settings › Tax shows the channel's tax, read-only: prices without tax and the zone's rates", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'tax');
  await expect(page.getByTestId('settings-section-tax')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tax-prices-include')).toHaveText('Prices include tax: No');
  await expect(page.getByTestId('tax-based-on')).toHaveText("Tax based on: the channel's default tax zone");
  await expect(page.getByTestId('tax-rate-1')).toHaveText('Standard DE · 19 %');
  await expect(page.getByTestId('tax-rate-2')).toHaveText('Reduced DE · 7 %');
});

test('with printing after each sale on, the receipt prints once by itself', async ({ page }) => {
  await page.addInitScript(() => {
    window.printCalls = 0;
    window.print = () => { window.printCalls++; };
  });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'printing');
  await expect(page.getByTestId('auto-print-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('auto-print-toggle').click();
  await expect(page.getByTestId('auto-print-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await page.getByTestId('receipt-print').click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(2);
  await page.getByTestId('new-sale').click();
  await openSettings(page, 'printing');
  await page.getByTestId('auto-print-toggle').click();
  await expect(page.getByTestId('auto-print-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('settings-back').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  await typeAmount(page, '9.52');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt')).toBeVisible();
  await page.getByTestId('receipt-print').click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(3);
});

test('with the receipt after each sale off, a cash sale ends on an empty cart, and on again shows the receipt', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openSettings(page, 'printing');
  await expect(page.getByTestId('auto-show-receipt-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('auto-show-receipt-toggle').click();
  await expect(page.getByTestId('auto-show-receipt-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('settings-back').click();
  await openRegister(page);

  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  await typeAmount(page, '9.52');
  await takePayment(page);
  await page.getByTestId('tender-pane').getByTestId('tender-complete').click();
  await expect(page.getByTestId('sale-complete-toast')).toBeVisible();
  await expect(page.getByTestId('sale-complete-toast')).toHaveText('Sale complete');
  await expect(page.getByTestId('receipt')).toHaveCount(0);
  await expect(page.getByTestId('cart').getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);

  await openSettings(page, 'printing');
  await page.getByTestId('auto-show-receipt-toggle').click();
  await expect(page.getByTestId('auto-show-receipt-toggle')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  await typeAmount(page, '9.52');
  await takePayment(page);
  await page.getByTestId('tender-pane').getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt')).toBeVisible();
  await page.getByTestId('new-sale').click();
});

test('a second tab is told the till is open in another tab, and opens after the first closes and it reloads', async ({ page, context }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByTestId('storage-failure')).toHaveText('VendurePOS is open in another tab. Close it, then reload this page.', { timeout: 30_000 });
  await expect(second.getByTestId('storage-failure-reload')).toBeVisible();
  await expect(second.getByTestId('storage-failure-detail')).toContainText('another tab holds the database');
  await expect(second.getByTestId('signed-in-store')).toHaveCount(0);
  // The first tab is untouched.
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeVisible();
  // The remedy the notice gives: close the other tab, then reload.
  await page.close();
  await second.getByTestId('storage-failure-reload').click();
  await expect(second.getByTestId('signed-in-store')).toBeVisible({ timeout: 30_000 });
  await expect(second.getByTestId('storage-failure')).toHaveCount(0);
});

test('a demo cashier changes a line\'s price and sells at it', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const cart = page.getByTestId('cart');
  await cart.getByTestId('cart-line-TALLY-MUG').getByTestId('price-popover-trigger').click();
  await page.getByTestId('price-popover-keypad-key-5').click();
  await expect(page.getByTestId('price-popover-value')).toHaveText('5');
  await page.getByTestId('price-popover-apply').click();
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toContainText('€5.00');
  await expect(cart.getByTestId('cart-total')).toHaveText('€5.95');
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '5.95');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  const receiptLine = page.getByTestId('receipt').getByText('1 × Tally Fixture Mug', { exact: true });
  await expect(receiptLine).toBeVisible();
  await expect(receiptLine.locator('..').getByText('€5.00', { exact: true })).toBeVisible();
});

test('a demo cashier takes 10 % off a line on its price keypad, and lines keep their actions in the quantity keypad', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const line = page.getByTestId('cart').getByTestId('cart-line-TALLY-MUG');
  await expect(line.getByRole('button', { name: 'Discount', exact: true })).toHaveCount(0);
  await expect(line.getByTestId('line-remove-TALLY-MUG')).toHaveCount(0);
  await line.getByTestId('price-popover-trigger').click();
  await page.getByTestId('price-discount-10').click();
  await page.getByTestId('price-popover-apply').click();
  await expect(line).toContainText('€7.20');
  await expect(page.getByTestId('cart').getByTestId('cart-total')).toHaveText('€8.57');
  await line.getByTestId('quantity-popover-trigger').click();
  await expect(page.getByTestId('quantity-popover-action-discount')).toBeVisible();
  await expect(page.getByTestId('quantity-popover-action-remove')).toBeVisible();
  await expect(page.getByTestId('quantity-popover-action-price')).toHaveCount(0);
  await page.getByTestId('quantity-popover-action-remove').click();
  await expect(line).toHaveCount(0);
});

test('Settings › General sets the quick discounts the price keypad offers', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('quick-discounts')).toHaveValue('5, 10, 15');
  await page.getByTestId('quick-discounts').fill('0, 10');
  await page.getByTestId('quick-discounts-save').click();
  await expect(page.getByTestId('quick-discounts-error')).toBeVisible();
  await page.getByTestId('quick-discounts').fill('50 20');
  await page.getByTestId('quick-discounts-save').click();
  await expect(page.getByTestId('quick-discounts-saved')).toBeVisible();
  await expect(page.getByTestId('quick-discounts')).toHaveValue('50, 20');
  await page.getByTestId('settings-back').click();
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const line = page.getByTestId('cart').getByTestId('cart-line-TALLY-MUG');
  await line.getByTestId('price-popover-trigger').click();
  await expect(page.getByTestId('price-discount-50')).toBeVisible();
  await expect(page.getByTestId('price-discount-20')).toBeVisible();
  await expect(page.getByTestId('price-discount-10')).toHaveCount(0);
  await page.getByTestId('price-discount-50').click();
  await page.getByTestId('price-popover-apply').click();
  await expect(line).toContainText('€4.00');
});

test('at phone width the price keypad folds into the line\'s quantity keypad', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await page.getByTestId('tab-cart').click();
  await openRegister(page);
  await page.getByTestId('tab-products').click();
  await page.getByRole('searchbox').fill('Mug');
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('tab-cart').click();
  await expect(page.getByTestId('cart').getByTestId('price-popover-trigger')).toHaveCount(0);
  await lineAction(page, 'TALLY-MUG', 'price');
  await expect(page.getByTestId('price-form')).toBeVisible();
});

test('a demo cashier parks a sale, sells another, then resumes the parked one', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('parked-open').click();
  await page.getByTestId('parked-sales-park').click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);
  await page.getByTestId('parked-sales-dismiss').click();
  await expect(page.getByTestId('parked-open')).toHaveText('Parked (1)');

  await page.getByTestId('product-tile-Filter Coffee').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await typeAmount(page, '20.00');
  await takePayment(page);
  await tender.getByTestId('tender-complete').click();
  await expect(page.getByTestId('receipt').getByText('1 × Filter Coffee', { exact: true })).toBeVisible();
  await page.getByTestId('new-sale').click();

  await page.getByTestId('parked-open').click();
  const resume = page.locator('[data-testid^="parked-resume-"]');
  await expect(resume).toHaveCount(1);
  await resume.click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await expect(page.getByTestId('cart-line-FIL-500')).toHaveCount(0);
  await expect(page.getByTestId('parked-open')).toHaveText('Park');

  // Park the resumed mug again, then recover it from the local collection after a reload.
  await page.getByTestId('parked-open').click();
  await page.getByTestId('parked-sales-park').click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);
  await expect(resume).toHaveCount(1);
  await page.reload();
  await expectSignedIn(page);
  await expect(page.getByTestId('parked-open')).toHaveText('Parked (1)');
  await page.getByTestId('parked-open').click();
  await expect(resume).toHaveCount(1);
  await resume.click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await expect(page.getByTestId('parked-open')).toHaveText('Park');
});

test('the demo page says what to try and links to the site and the quick start', async ({ page }) => {
  const cspConsole: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
  });
  await page.goto('/demo');
  const demoTry = page.getByTestId('demo-try');
  for (const text of ['What to try', 'Orders', 'price', 'Park', 'Split', 'customer', 'Register']) {
    await expect(demoTry).toContainText(text);
  }
  await expect(page.getByTestId('demo-try-device-key')).toContainText('device key');
  await expect(page.getByTestId('demo-link-site')).toHaveAttribute('href', /^https:\/\/vendurepos\.com\/?$/);
  await expect(page.getByTestId('demo-link-quickstart')).toHaveAttribute('href', 'https://vendurepos.com/docs/quick-start');
  await expect(page.getByTestId('demo-links')).toHaveCount(0);
  expect(cspConsole).toEqual([]);
});

test('a demo cashier splits a sale between cash and card', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const cart = page.getByTestId('cart');
  await expect(cart.getByTestId('cart-paid')).toHaveText('€0.00');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€9.52');
  await page.getByTestId('tender-method-cash').click();
  // The keypad has no decimal key: digits shift in from the right, so 5, 0, 0 is €5.00.
  for (const key of ['5', '0', '0']) await page.getByTestId(`tender-keypad-key-${key}`).click();
  await page.getByTestId('tender-take').click();
  await expect(page.getByTestId('tender-complete')).toBeDisabled();
  await expect(cart.getByTestId('cart-paid')).toHaveText('€5.00');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€4.52');
  await page.getByTestId('tender-method-external').click();
  // The pane pre-types the remaining balance after the cash payment is taken.
  await page.getByTestId('tender-take').click();
  await expect(page.locator('[data-testid^="tender-leg-"]:not([data-testid$="-status"]):not([data-testid$="-void"])')).toHaveCount(2);
  await expect(page.getByTestId('tender-complete')).toBeEnabled();
  await page.getByTestId('tender-complete').click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByTestId('receipt-payment-cash')).toHaveText('€5.00');
  await expect(receipt.getByTestId('receipt-payment-external')).toBeVisible();
  await expect(receipt.getByTestId('receipt-change')).toHaveText('€0.00');
});

test('a demo cashier splits a sale evenly two ways and pays one part in cash', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€9.52');
  await expect(page.getByTestId('tender-split-ways')).toHaveCount(0);
  await page.getByTestId('tender-split-open').click();
  await expect(page.getByTestId('tender-split-ways')).toBeVisible();
  await page.getByTestId('tender-split-ways-2').click();
  await expect(page.getByTestId('tender-split-ways')).toHaveCount(0);
  await expect(tender.getByTestId('tender-plan')).toHaveText('1 of 2');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€4.76');
  await takePayment(page);
  await expect(cart.getByTestId('cart-paid')).toHaveText('€4.76');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€4.76');
  await expect(tender.getByTestId('tender-balance')).toContainText('€4.76');
  await expect(tender.getByTestId('tender-plan')).toHaveText('2 of 2');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€4.76');
  await expect(tender.getByTestId('tender-complete')).toBeDisabled();
});

test('a demo cashier pays a fixed amount first and the rest after', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender-pane');
  await page.getByTestId('tender-split-open').click();
  await page.getByTestId('tender-split-amount').fill('9.52');
  await expect(page.getByTestId('tender-split-amount-set')).toBeDisabled();
  await page.getByTestId('tender-split-amount').fill('5.00');
  await expect(page.getByTestId('tender-split-amount-set')).toBeEnabled();
  await page.getByTestId('tender-split-amount-set').click();
  await expect(page.getByTestId('tender-split-ways')).toHaveCount(0);
  await expect(tender.getByTestId('tender-plan')).toHaveText('1 of 2');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€5.00');
  await takePayment(page);
  await expect(cart.getByTestId('cart-paid')).toHaveText('€5.00');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€4.52');
  await expect(tender.getByTestId('tender-plan')).toHaveText('2 of 2');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€4.52');
  await expect(tender.getByTestId('tender-complete')).toBeDisabled();
});

test('a demo cashier pays for one item first and the rest after', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('product-tile-Canvas Apron').click();
  await checkout(page);
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender-pane');
  await page.getByTestId('tender-split-open').click();
  const lines = page.getByTestId('tender-split-line');
  const mug = lines.filter({ hasText: 'Tally Fixture Mug' });
  const apron = lines.filter({ hasText: 'Canvas Apron' });
  await expect(lines).toHaveCount(2);
  await expect(mug).toContainText('€9.52');
  await expect(apron).toContainText('€41.64');
  await expect(page.getByTestId('tender-split-items-set')).toBeDisabled();
  await mug.click();
  await expect(page.getByTestId('tender-split-items-set')).toBeEnabled();
  await apron.click();
  await expect(page.getByTestId('tender-split-items-set')).toBeDisabled();
  await apron.click();
  await page.getByTestId('tender-split-items-set').click();
  await expect(page.getByTestId('tender-split-ways')).toHaveCount(0);
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€9.52');
  await takePayment(page);
  await expect(cart.getByTestId('cart-paid')).toHaveText('€9.52');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€41.64');
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€41.64');
  await expect(tender.getByTestId('tender-complete')).toBeDisabled();
  await page.getByTestId('tender-split-open').click();
  await expect(mug).toContainText('Paid');
  await expect(mug).toBeDisabled();
  await expect(page.getByTestId('tender-split-items-note')).toHaveCount(0);
});

test('a demo cashier pays for one item first under an order discount', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('product-tile-Canvas Apron').click();
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender-pane');
  // TallyUI's DiscountForm, as in sign-in.spec.ts: a €1.00 order discount.
  await cart.getByTestId('order-discount').click();
  const form = cart.getByRole('group', { name: 'Order discount' });
  await form.getByRole('button', { name: 'Amount' }).click();
  await form.getByLabel('Discount value').fill('1.00');
  await form.getByRole('button', { name: 'Apply' }).click();
  await expect(form).toHaveCount(0);
  await checkout(page);
  await page.getByTestId('tender-split-open').click();
  // Shares 19 / 81 of the €1.00: nets 781 / 3418, tax 148 / 649 per line, the order's tax 797.81 -> 798, so €49.97.
  await expect(page.getByTestId('tender-split-items-note')).toHaveText("Each item's share includes its part of the order discount.");
  const lines = page.getByTestId('tender-split-line');
  const mug = lines.filter({ hasText: 'Tally Fixture Mug' });
  const apron = lines.filter({ hasText: 'Canvas Apron' });
  await expect(mug).toContainText('€9.29');
  await expect(apron).toContainText('€40.67');
  await mug.click();
  await apron.click();
  await expect(page.getByTestId('tender-split-items-set')).toBeDisabled();
  await apron.click();
  await page.getByTestId('tender-split-items-set').click();
  await expect(tender.getByTestId('tender-entry-amount')).toHaveText('€9.29');
  await takePayment(page);
  await expect(cart.getByTestId('cart-paid')).toHaveText('€9.29');
  await expect(cart.getByTestId('cart-remaining')).toHaveText('€40.68');
  await page.getByTestId('tender-split-open').click();
  await expect(mug).toContainText('Paid');
  await expect(mug).toBeDisabled();
  await apron.click();
  await expect(page.getByTestId('tender-split-items-set')).toBeDisabled();
});

test('a demo cashier pays cash with a quick amount: the cart is locked beside the checkout', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeHidden();
  const cart = page.getByTestId('cart');
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await expect(cart.getByTestId('quantity-popover-trigger')).toHaveCount(0);
  await expect(cart.getByTestId('price-popover-trigger')).toHaveCount(0);
  await expect(cart.getByTestId('checkout')).toHaveCount(0);
  await expect(cart.getByTestId('cart-remaining')).toBeVisible();
  await expect(cart.getByTestId('add-charge')).toHaveCount(0);
  await page.getByTestId('tender-quick-5000').click();
  await takePayment(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender.getByTestId('tender-change')).toContainText('€40.48');
  await expect(tender.getByTestId('tender-complete')).toBeEnabled();
  await tender.getByTestId('tender-complete').click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByTestId('receipt-change')).toHaveText('€40.48');
  await receipt.getByTestId('new-sale').click();
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeVisible();
});

// Row 6.4: a refusal during a tender reaches the cashier as its message alone (TallyUI errorText), never the class name.
test('a demo cashier who closes the register during a checkout is told to finish the sale, in plain words', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await checkout(page);
  const tender = page.getByTestId('tender-pane');
  await expect(tender).toBeVisible();

  await page.getByTestId('register-open-panel').click();
  const panel = page.getByTestId('register-panel');
  await panel.getByTestId('register-panel-close').click();
  await expect(panel.getByText('Finish or cancel the sale in progress first.', { exact: true })).toBeVisible();
  await expect(panel).not.toContainText('RegisterTenderInProgressError');
  await expect(panel).not.toContainText('Error:');
  await expect(page.getByTestId('register-count')).toHaveCount(0);

  await panel.getByTestId('register-panel-dismiss').click();
  await expect(panel).toHaveCount(0);
  await expect(tender).toBeVisible();
});

test('a demo cashier adds a fee, removes one and sells with a Reduced-class fee', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const cart = page.getByTestId('cart');
  const form = cart.getByRole('group', { name: 'Add charge' });
  await cart.getByTestId('add-charge').click();
  await form.getByRole('button', { name: 'Fee', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Bag');
  await form.getByLabel('Amount', { exact: true }).fill('0.10');
  await form.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(cart.getByTestId('cart-fee-0')).toContainText('Bag');
  await cart.getByRole('button', { name: 'Remove Bag', exact: true }).click();
  await expect(cart.getByTestId('cart-fee-0')).toHaveCount(0);
  await cart.getByTestId('add-charge').click();
  await form.getByRole('button', { name: 'Fee', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Gift wrap');
  await form.getByLabel('Amount', { exact: true }).fill('2.00');
  await form.getByRole('group', { name: 'Tax class' }).getByRole('button', { name: 'Reduced DE', exact: true }).click();
  await form.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(cart.getByTestId('cart-fee-0-amount')).toHaveText('€2.00');
  await expect(cart.getByTestId('cart-tax-Reduced DE 7%')).toHaveText('€0.14');
  await expect(cart.getByTestId('cart-total')).toHaveText('€11.66');
  await checkout(page);
  await page.getByTestId('tender-method-external').click();
  await takePayment(page);
  await page.getByTestId('tender-pane').getByTestId('tender-complete').click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByTestId('receipt-fee-0')).toHaveText('€2.00');
  await expect(receipt.getByTestId('receipt-tax-Reduced DE 7%')).toHaveText('€0.14');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('€11.66');
});

test('a demo cashier picks a category, still scans a product from another, and switches the products to a table', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);

  const categories = page.getByRole('radiogroup', { name: 'Categories' });
  const allProducts = categories.getByRole('radio', { name: 'All products', exact: true });
  const coffee = categories.getByRole('radio', { name: 'Coffee', exact: true });
  await expect(allProducts).toHaveAttribute('aria-checked', 'true');
  await expect(categories.getByRole('radio')).toHaveCount(new Set(CATALOGUE.map(p => p.category)).size + 1);

  await coffee.click();
  await expect(coffee).toHaveAttribute('aria-checked', 'true');
  await expect(allProducts).toHaveAttribute('aria-checked', 'false');
  const tiles = page.locator('[data-testid^="product-tile-"]');
  const mugTile = page.getByTestId('product-tile-Tally Fixture Mug');
  await expect(tiles).toHaveCount(CATALOGUE.filter(p => p.category === 'Coffee').length);
  await expect(page.getByTestId('product-tile-Espresso Beans')).toBeVisible();
  await expect(mugTile).toHaveCount(0);

  const search = page.getByPlaceholder('Search or scan barcode / SKU');
  await search.fill('TALLY-MUG');
  await search.press('Enter');
  await expect(page.getByTestId('cart')).toContainText('Tally Fixture Mug');
  await expect(search).toHaveValue('');
  await expect(coffee).toHaveAttribute('aria-checked', 'true');
  await expect(mugTile).toHaveCount(0);

  await allProducts.click();
  await expect(mugTile).toBeVisible();

  const tableToggle = page.getByTestId('view-toggle-table');
  await tableToggle.click();
  await expect(tableToggle).toHaveAttribute('aria-checked', 'true');
  await expect(tiles).toHaveCount(0);
  // The table renders its rows lazily, so check the first row by name rather than one further down.
  await expect(page.locator('[data-testid^="product-row-"]').filter({ hasText: 'Canvas Apron' })).toBeVisible();
  await page.getByTestId('view-toggle-grid').click();
  await expect(mugTile).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('a demo cashier keeps two sales open as tabs under the cart and switches between them', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);

  await expect(page.getByTestId('open-sale-tabs')).toBeVisible();
  await expect(page.getByTestId('new-sale-tab-label')).toHaveText('New');

  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const mugTab = page.getByRole('tab', { name: /Tally Fixture Mug/ });
  await expect(mugTab).toBeVisible();
  await expect(mugTab).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('new-sale-tab').click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);
  await expect(mugTab).toHaveAttribute('aria-selected', 'false');

  await page.getByTestId('product-tile-Filter Coffee').click();
  await expect(page.getByTestId('cart-line-FIL-500')).toBeVisible();
  const coffeeTab = page.getByRole('tab', { name: /Filter Coffee/ });
  await expect(coffeeTab).toHaveAttribute('aria-selected', 'true');

  await mugTab.click();
  await expect(page.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await expect(page.getByTestId('cart-line-FIL-500')).toHaveCount(0);
  await expect(coffeeTab).toHaveAttribute('aria-selected', 'false');
});

test('Settings › General puts the open orders at the top or the foot of the cart', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  await openRegister(page);
  const tabsOnTop = async () => {
    const tabs = await page.getByTestId('open-sale-tabs').boundingBox();
    const customer = await page.getByTestId('customer-row').boundingBox();
    return tabs && customer ? tabs.y < customer.y : null;
  };
  await expect.poll(tabsOnTop).toBe(false);
  await openSettings(page, 'general');
  await expect(page.getByTestId('open-orders-bottom')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('open-orders-top').click();
  await expect(page.getByTestId('open-orders-top')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-back').click();
  await expect.poll(tabsOnTop).toBe(true);
  await openSettings(page, 'general');
  await page.getByTestId('open-orders-bottom').click();
  await page.getByTestId('settings-back').click();
  await expect.poll(tabsOnTop).toBe(false);
});

test("the In Stock pill is on by default, hides the shelf's sold-out products and shows them when tapped off", async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const pill = page.getByTestId('filter-chip-inStock');
  const carafe = page.getByTestId('product-tile-Glass Carafe');
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  // The demo seed gives the carafe 0 on the shop floor.
  await expect(carafe).toHaveCount(0);
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeVisible();

  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await expect(carafe).toBeVisible();
  await expect(carafe).toContainText('Out of Stock');

  await pill.click();
  await expect(carafe).toHaveCount(0);
});

test('Settings › Products shows out-of-stock products: the In Stock pill starts off and follows the setting', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('demo-enter').click();
  await expectSignedIn(page);
  const toggle = page.getByTestId('show-out-of-stock-toggle');
  const pill = page.getByTestId('filter-chip-inStock');
  const carafe = page.getByTestId('product-tile-Glass Carafe');
  await page.getByTestId('settings-open').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-back').click();
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
  await expect(carafe).toBeVisible();
  await page.getByTestId('settings-open').click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('settings-back').click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(carafe).toHaveCount(0);
});

test('the demo build has no customer display: /display lands on /', async ({ page }) => {
  // app/display.tsx redirects to /, which sends a signed-out demo visitor on to /demo (Front desk ruling 3, 2026-11-18).
  await page.goto('/display?store=https://store.example.com');
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByTestId('demo-enter')).toBeVisible();
  await expect(page.getByTestId('display-store-url')).toHaveCount(0);
});
