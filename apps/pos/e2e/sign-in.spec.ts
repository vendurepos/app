import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window { cspViolations: string[] }
}

let cspConsole: string[] = [];
// TallyUI #315's one-connector-two-databases warning is dev-only and this is a production build, so the per-session guard is the unit test in lib/catalogue.test.ts.

// public/index.html's CSP meta must hold for the whole flow. A reload starts a new array, so read it before each one.
test.beforeEach(async ({ page }) => {
  // An invalid CSP source is a build mistake and a refusal is a violation, so either console message fails the smoke.
  const messages: string[] = [];
  cspConsole = messages;
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) messages.push(message.text());
  });
  await page.addInitScript(() => {
    window.cspViolations = [];
    window.addEventListener('securitypolicyviolation', (event) => {
      window.cspViolations.push(`${event.effectiveDirective} blocked ${event.blockedURI}`);
    });
  });
});

async function cspViolations(page: Page) {
  return page.evaluate(() => window.cspViolations);
}

async function expectCspMeta(page: Page) {
  expect(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null))
    .toBe(true);
}

// scripts/smoke-web.sh provides E2E_STORE_URL and defaults the store port to 3200.
const STORE_URL = process.env.E2E_STORE_URL ?? 'http://127.0.0.1:3200';
// dev/vendure-store/src/constants.ts defines POS_CHANNEL_TOKEN.
const CHANNEL_TOKEN = 'vendurepos-dev-pos';
// dev/vendure-store/src/constants.ts defines SUPERADMIN_USERNAME.
const USERNAME = 'superadmin';
// dev/vendure-store/src/constants.ts defines SUPERADMIN_PASSWORD.
const PASSWORD = 'superadmin';

test('wrong password shows an error', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill('wrong-password');
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('sign-in-error')).toHaveText('Email or password is incorrect.');
  await expectCspMeta(page);
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});

test('signs in to the dev store', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-barcode_field').fill('barcode');
  const stockResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().endsWith('/admin-api') && (response.request().postData() ?? '').includes('VariantStock'));
  const idsResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && response.url().endsWith('/admin-api') && (response.request().postData() ?? '').includes('GetProductIds'));
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  for (const response of await Promise.all([stockResponse, idsResponse])) {
    expect(response.ok()).toBe(true);
    expect((await response.json()).errors).toBeUndefined();
  }
  for (const name of [
    'Tally Fixture Mug', 'Espresso Beans', 'Filter Coffee', 'Tally T-Shirt', 'Tally Hoodie',
    'Tote Bag', 'Notebook', 'Postcard Set', 'Limited Print', 'Gift Card',
  ]) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
  const search = page.getByPlaceholder('Search or scan barcode / SKU');
  await search.fill('2000000000015');
  await expect(page.getByText('Tally Fixture Mug', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Espresso Beans', { exact: true })).toHaveCount(0);
  await search.fill('');
  const violations = await cspViolations(page);
  await page.reload();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  const storedSession = await page.evaluate(() => localStorage.getItem('vendurepos.session'));
  expect(storedSession).not.toBeNull();
  const session = JSON.parse(storedSession!);
  expect(session).not.toHaveProperty('password');
  const token = session.token;
  const beforeSignOut = await page.request.post(`${STORE_URL}/admin-api`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { query: '{ activeAdministrator { id } }' },
  });
  expect((await beforeSignOut.json()).data.activeAdministrator.id).not.toBeNull();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('sign-in-submit')).toBeVisible();
  // signOut() clears the stored session before the sign-in screen renders (lib/session.ts SESSION_KEY).
  expect(await page.evaluate(() => localStorage.getItem('vendurepos.session'))).toBeNull();
  const response = await page.request.post(`${STORE_URL}/admin-api`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { query: '{ activeAdministrator { id } }' },
  });
  expect((await response.json()).data.activeAdministrator).toBeNull();
  await page.route('**/admin-api', (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    return request.method() === 'POST' && (body.includes('products(') || body.includes('productVariants('))
      ? route.abort()
      : route.continue();
  });
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  // Same barcode field, so the same catalogue database name: only the removal at sign-out keeps the mug away.
  await page.getByTestId('sign-in-barcode_field').fill('barcode');
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByText(/Failed to fetch/).first()).toBeVisible();
  // The status line has left "Syncing catalogue…" for its final state, so the empty list below is not mid-sync.
  await expect(page.getByText('Syncing catalogue…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tally Fixture Mug', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No products yet.', { exact: true })).toBeVisible();
  await page.unroute('**/admin-api');
  violations.push(...await cspViolations(page));
  await page.reload();
  await expect(page.getByText('Tally Fixture Mug', { exact: true }).first()).toBeVisible();
  await expectCspMeta(page);
  violations.push(...await cspViolations(page));
  expect(violations).toEqual([]);
  expect(cspConsole).toEqual([]);
});

// The store's /info advertises per_rate_group_items / half_up (vendurepos #60); lib/cart-totals.test.ts checks every
// figure below against TallyUI's taxFiguresForBasket.
test('the cart waits for the store tax settings, then totals a sale with them', async ({ page }) => {
  // An unreachable /info is a failed read, not the default per_order rounding: no cart until a retry gets through.
  let infoAborts = 0;
  await page.route('**/tally/v1/info', (route) => { infoAborts++; return route.abort(); });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  const cart = page.getByTestId('cart');
  await expect(page.getByTestId('sale-settings-retrying')).toHaveText("Can't reach the store's settings yet. Retrying…");
  await expect(cart).toHaveCount(0);
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toHaveCount(0);
  // Sign-in's own read and at least one of the sale's have failed.
  expect(infoAborts).toBeGreaterThanOrEqual(2);
  await page.unroute('**/tally/v1/info');
  await expect(cart).toBeVisible();
  await expect(page.getByTestId('sale-settings-retrying')).toHaveCount(0);
  const expectTotals = async (subtotal: string, tax: string, total: string, rates: Record<string, string>) => {
    await expect(cart.getByTestId('cart-subtotal')).toHaveText(subtotal);
    await expect(cart.getByTestId('cart-tax')).toHaveText(tax);
    await expect(cart.getByTestId('cart-total')).toHaveText(total);
    // Named by the store's own rates, which per_rate_group_items groups by.
    for (const [label, amount] of Object.entries(rates)) await expect(cart.getByTestId(`cart-tax-${label}`)).toHaveText(amount);
    await expect(cart.getByTestId(/^cart-tax-/)).toHaveCount(Object.keys(rates).length);
  };
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await page.getByTestId('product-tile-Espresso Beans').click();
  await page.getByRole('button', { name: /ESP-250/ }).click();
  const beans = cart.getByTestId('cart-line-ESP-250');
  await beans.getByText('+', { exact: true }).click();
  await beans.getByText('+', { exact: true }).click();
  await expect(beans).toContainText('Espresso Beans');
  await expect(beans).toContainText('€26.97');
  // 152 + 188.79 -> 189 = 341 (per_order gives 341 too).
  await expectTotals('€34.97', '€3.41', '€38.38', { 'Standard DE 19%': '€1.52', 'Reduced DE 7%': '€1.89' });
  // Two postcard sets: Standard 1998 x 19 % = 379.62 -> 380, so 569, where per_order's 568.41 gives 568.
  await page.getByTestId('product-tile-Postcard Set').click();
  await page.getByTestId('product-tile-Postcard Set').click();
  await expectTotals('€46.95', '€5.69', '€52.64', { 'Standard DE 19%': '€3.80', 'Reduced DE 7%': '€1.89' });
  // − at quantity 1 takes the mug off: Standard 1198 x 19 % = 227.62 -> 228, so 417 (per_order 416).
  await cart.getByTestId('cart-line-TALLY-MUG').getByText('−', { exact: true }).click();
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toHaveCount(0);
  await expectTotals('€38.95', '€4.17', '€43.12', { 'Standard DE 19%': '€2.28', 'Reduced DE 7%': '€1.89' });
  await expectCspMeta(page);
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});

test('a session revoked on the store stops the catalogue with a notice', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByText('Tally Fixture Mug', { exact: true }).first()).toBeVisible();
  const token = JSON.parse((await page.evaluate(() => localStorage.getItem('vendurepos.session')))!).token;
  // Ends the session on the store behind the app's back, as an expiry or an admin would.
  const logout = await page.request.post(`${STORE_URL}/admin-api`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { query: 'mutation { logout { success } }' },
  });
  expect((await logout.json()).data.logout.success).toBe(true);
  const violations = await cspViolations(page);
  // A reload starts a product pull with the stored, now revoked, token.
  const pull = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.request().method() === 'POST' && response.url().endsWith('/admin-api')
      && (body.includes('products(') || body.includes('productVariants('));
  });
  await page.reload();
  await pull;
  // TallyUI's notice$ (#261), never a stale catalogue that looks synced.
  await expect(page.getByText('Your session has ended. Sign out, then sign in again.', { exact: true })).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('sign-in-submit')).toBeVisible();
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByText('Tally Fixture Mug', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Your session has ended. Sign out, then sign in again.', { exact: true })).toHaveCount(0);
  violations.push(...await cspViolations(page));
  expect(violations).toEqual([]);
  expect(cspConsole).toEqual([]);
});
