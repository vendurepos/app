import { expect, test, type Page, type Route } from '@playwright/test';

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
test('the cart waits for the store tax settings, totals a sale with them, takes cash and keeps the order past sign-out', async ({ page }) => {
  // A 404 /info is a store with no plugin (or one from before /info): it reads as order.create 1, below the 4 whose
  // net-discount rule a discounted sale needs, so no cart until the plugin is there.
  const infoNotFound = (route: Route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 404, body: 'Not Found' }) : route.continue();
  // An unreachable /info is a failed read, not the default per_order rounding: no cart until a retry gets through.
  let infoAborts = 0;
  await page.route('**/tally/v1/info', (route) => { infoAborts++; return route.abort(); });
  // Registered last, so it answers first; un-routed, the abort above takes over with no gap.
  await page.route('**/tally/v1/info', infoNotFound);
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  const cart = page.getByTestId('cart');
  await expect(page.getByTestId('sale-settings-plugin'))
    .toHaveText("This store's VendurePOS plugin is missing or out of date. Install or update it, then this till continues.");
  await expect(cart).toHaveCount(0);
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toHaveCount(0);
  await page.unroute('**/tally/v1/info', infoNotFound);
  await expect(page.getByTestId('sale-settings-retrying')).toHaveText("Can't reach the store's settings yet. Retrying…");
  await expect(cart).toHaveCount(0);
  await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toHaveCount(0);
  // At least one of the sale's reads has failed (sign-in's own read was the 404 above).
  expect(infoAborts).toBeGreaterThanOrEqual(1);
  await page.unroute('**/tally/v1/info');
  // The store can't be reached for orders: the sale is kept and waits, and each attempt is recorded.
  const sent: { version: number; payload: { clientOrderId: string } }[] = [];
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(...route.request().postDataJSON().commands);
    return route.abort();
  });
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
  // Cash 50.00 for the €43.12 total: €6.88 change.
  await cart.getByTestId('pay-cash').click();
  const tender = page.getByTestId('tender');
  await expect(tender.getByTestId('tender-total')).toHaveText('€43.12');
  await tender.getByTestId('cash-tendered').locator('input').fill('50.00');
  await expect(tender.getByTestId('tender-change')).toContainText('€6.88');
  await tender.getByTestId('tender-complete').click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('€43.12');
  await expect(receipt.getByTestId('receipt-tax-Standard DE 19%')).toHaveText('€2.28');
  await expect(receipt.getByTestId('receipt-tax-Reduced DE 7%')).toHaveText('€1.89');
  await expect(receipt.getByTestId('receipt-payment-cash')).toHaveText('€50.00');
  await expect(receipt.getByTestId('receipt-change')).toHaveText('€6.88');
  await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
  // Sent at the plugin's order.create 4 (its /info was read before the outbox opened), one order under one id.
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const orderId = sent[0].payload.clientOrderId;
  expect(sent.every((command) => command.version === 4 && command.payload.clientOrderId === orderId)).toBe(true);
  await receipt.getByTestId('new-sale').click();
  await expect(cart.getByTestId(/^cart-line-/)).toHaveCount(0);
  await expect(cart.getByTestId('cart-total')).toHaveText('€0.00');
  // Sign-out removes the catalogue database; the stored order is in its own database and must still be there.
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('sign-in-submit')).toBeVisible();
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
  const violations = await cspViolations(page);
  // And after a reload, read back from storage rather than any handle the page still held.
  await page.reload();
  await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
  // The reload's outbox retries from a 1 s backoff, doubling, so its next attempt after the un-route comes within
  // seconds: no second reload to flush.
  await page.unroute('**/tally/v1/commands');
  await expect(page.getByTestId('orders-waiting')).toHaveCount(0, { timeout: 30_000 });
  const token = JSON.parse((await page.evaluate(() => localStorage.getItem('vendurepos.session')))!).token;
  const created = await page.request.post(`${STORE_URL}/admin-api`, {
    headers: { Authorization: `Bearer ${token}`, 'vendure-token': CHANNEL_TOKEN },
    data: {
      query: 'query ($id: String!) { orders(options: { filter: { tallyClientOrderId: { eq: $id } } }) { items { totalWithTax } } }',
      variables: { id: orderId },
    },
  });
  expect((await created.json()).data.orders.items).toEqual([{ totalWithTax: 4312 }]);
  await expectCspMeta(page);
  violations.push(...await cspViolations(page));
  expect(violations).toEqual([]);
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

test('a rejected sale needs attention, is retried from the Orders panel and applies; a refused batch is sent again', async ({ page }) => {
  // The store rejects every order it is sent: each stays rejected until the cashier retries it.
  const sent: { id: string; payload: { clientOrderId: string } }[] = [];
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const commands: typeof sent = route.request().postDataJSON().commands;
    sent.push(...commands);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: commands.map(({ id }) => ({
      id, status: 'rejected', error: { code: 'invalid_payload', message: 'test refusal' },
    })) }) });
  });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  const token = JSON.parse((await page.evaluate(() => localStorage.getItem('vendurepos.session')))!).token;
  const cart = page.getByTestId('cart');
  const panel = page.getByTestId('orders-panel');
  // Pays the cart's total in cash; resolves to the order's client id and its receipt total in minor units.
  const cashSale = async () => {
    const before = sent.length;
    await cart.getByTestId('pay-cash').click();
    const tender = page.getByTestId('tender');
    await tender.getByTestId('cash-tendered').locator('input').fill((await tender.getByTestId('tender-total').innerText()).replace(/[^\d.]/g, ''));
    await tender.getByTestId('tender-complete').click();
    const total = Math.round(Number((await page.getByTestId('receipt').getByTestId('receipt-total').innerText()).replace(/[^\d.]/g, '')) * 100);
    await expect.poll(() => sent.length).toBeGreaterThan(before);
    return { orderId: sent[before].payload.clientOrderId, total };
  };
  // The Admin API's tallyClientOrderId is the order's id, whatever command id delivered it.
  const expectOnStore = async ({ orderId, total }: { orderId: string; total: number }) => {
    const found = await page.request.post(`${STORE_URL}/admin-api`, {
      headers: { Authorization: `Bearer ${token}`, 'vendure-token': CHANNEL_TOKEN },
      data: {
        query: 'query ($id: String!) { orders(options: { filter: { tallyClientOrderId: { eq: $id } } }) { items { totalWithTax } } }',
        variables: { id: orderId },
      },
    });
    expect((await found.json()).data.orders.items).toEqual([{ totalWithTax: total }]);
  };
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  const first = await cashSale();
  await expect(page.getByTestId('orders-rejected')).toHaveText('1 order needs attention');
  await page.getByTestId('new-sale').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  // Opened from the count: the order is under "Needs attention" with its reason, and the sale is out of sight.
  await page.getByTestId('orders-rejected').click();
  await expect(panel.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  // Both sections list it with its reason; "Needs attention" comes first and alone has its Retry.
  await expect(panel.getByText("The online store refused this sale: this till sent it in a form the store can't read.", { exact: false }))
    .toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Retry' })).toHaveCount(1);
  await expect(cart).toBeHidden();
  await page.getByTestId('orders-close').click();
  await expect(panel).toHaveCount(0);
  // Only hidden, never unmounted: the new cart still holds its item.
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  // Retried against the real store: requeue sends it under a new command id, and it applies.
  await page.unroute('**/tally/v1/commands');
  await page.getByTestId('orders-open').click();
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('orders-rejected')).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByRole('heading', { name: 'Needs attention' })).toHaveCount(0);
  await expect(panel.getByText(/· Synced$/)).toHaveCount(1);
  await expectOnStore(first);
  await page.getByTestId('orders-close').click();
  // The store refuses the whole batch: the outbox keeps it and pauses until Send again flushes.
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(...route.request().postDataJSON().commands);
    return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'test refusal' }) });
  });
  const second = await cashSale();
  await expect(page.getByTestId('orders-notice')).toContainText('The store refused the orders (test refusal)');
  await expect(page.getByTestId('orders-send-again')).toBeVisible();
  await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
  await page.unroute('**/tally/v1/commands');
  await page.getByTestId('orders-send-again').click();
  await expect(page.getByTestId('orders-waiting')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('orders-notice')).toHaveCount(0);
  await expectOnStore(second);
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});
