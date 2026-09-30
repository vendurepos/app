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

// A sale needs an open register session: opens this till's drawer with a float. On a narrow screen the open card is
// on the Cart tab.
async function openRegister(page: Page, float = '100.00') {
  const card = page.getByTestId('open-register-card');
  await card.getByTestId('open-register-amount').fill(float);
  await card.getByTestId('open-register-button').click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toBeVisible();
}

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
  const sent: { type: string; version: number; payload: { clientOrderId: string } }[] = [];
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(...route.request().postDataJSON().commands.filter(({ type }: { type: string }) => type === 'order.create'));
    return route.abort();
  });
  await expect(cart).toBeVisible();
  await expect(page.getByTestId('sale-settings-retrying')).toHaveCount(0);
  await openRegister(page);
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
  const sent: { id: string; type: string; payload: { clientOrderId: string } }[] = [];
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const commands: typeof sent = route.request().postDataJSON().commands;
    // The register's commands are rejected too, but only the orders are followed here.
    sent.push(...commands.filter(({ type }) => type === 'order.create'));
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
  await openRegister(page);
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
    sent.push(...route.request().postDataJSON().commands.filter(({ type }: { type: string }) => type === 'order.create'));
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

type SentCommand = { id: string; type: string; payload: Record<string, unknown> };
type CommandResult = { id: string; status: string; register?: { closure?: { expected?: Record<string, number>; variance?: Record<string, number> } } };

test('a register day: open with a float, sell, move cash, count and close; the Z report and the plugin agree', async ({ page }) => {
  // Every command the till sends and the store's answer to it, unchanged.
  const commands: SentCommand[] = [];
  const results = new Map<string, CommandResult>();
  page.on('response', async (response) => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/tally/v1/commands')) return;
    commands.push(...response.request().postDataJSON().commands);
    for (const result of ((await response.json().catch(() => ({}))).results ?? []) as CommandResult[]) results.set(result.id, result);
  });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender');
  // No session: the cart builds, and the open card stands where Pay would be.
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  await expect(cart.getByTestId('open-register-card')).toBeVisible();
  await expect(cart.getByTestId('pay-cash')).toHaveCount(0);
  await openRegister(page, '100.00');
  // A cash sale and a card sale of the mug, €8.00 + 19 %: €9.52 each.
  await cart.getByTestId('pay-cash').click();
  await tender.getByTestId('cash-tendered').locator('input').fill('9.52');
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('new-sale').click();
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await cart.getByTestId('pay-card').click();
  await tender.getByTestId('tender-complete').click();
  await page.getByTestId('new-sale').click();
  // Paid in €10.00 and paid out €5.00 from the Register panel, then the paid in undone.
  await page.getByTestId('register-open-panel').click();
  const panel = page.getByTestId('register-panel');
  for (const [type, amount, reason] of [['paid-in', '10.00', 'Change from the bank'], ['paid-out', '5.00', 'Milk']]) {
    await panel.getByTestId(`register-panel-${type}`).click();
    const sheet = page.getByTestId('movement-sheet');
    await sheet.getByTestId('movement-amount').fill(amount);
    await sheet.getByTestId('movement-reason').fill(reason);
    await sheet.getByTestId('movement-confirm').click();
    await expect(sheet).toHaveCount(0);
  }
  await panel.getByTestId('register-panel-movements').click();
  const paidIn = panel.getByTestId(/^movement-row-/).filter({ hasText: 'Paid in' });
  const paidInId = (await paidIn.getAttribute('data-testid'))!.replace('movement-row-', '');
  await panel.getByTestId(`movement-void-${paidInId}`).click();
  await expect(paidIn).toHaveCount(0);
  await expect(panel.getByTestId('register-panel-sales-count')).toHaveText('2 sales this session');
  // €100.00 + €9.52 − €5.00.
  await expect(panel.getByTestId('register-panel-expected')).toContainText('€104.52');
  await panel.getByTestId('register-panel-close').click();
  const count = page.getByTestId('register-count');
  await count.getByTestId('count-amount').fill('104.52');
  await count.getByTestId('count-close').click();
  const sheet = page.getByTestId('closure-sheet');
  await expect(sheet.getByTestId('closure-expected-cash')).toHaveText('Expected €104.52');
  await expect(sheet.getByTestId('closure-counted-cash')).toHaveText('Counted €104.52');
  // The Z report as printed: TallyUI's closure document, through the print frame.
  await sheet.getByTestId('closure-print').click();
  const printed = await page.frameLocator('#vendurepos-print').locator('p').allTextContents();
  expect(printed).toEqual(expect.arrayContaining([
    'Z report · Closure #1', 'Sales 2', 'Sales total €19.04', 'Opening float €100.00', 'Cash sales €9.52', 'Card sales €9.52',
    'Tax 19%: net €16.00, tax €3.04, gross €19.04', 'Cash expected €104.52', 'Cash counted €104.52', 'Cash variance €0.00',
    'Card expected €9.52',
  ]));
  // The plugin applied the closure, and its expected and variance, from its own ledger, are the Z's.
  const open = commands.find(({ type }) => type === 'register.session.open')!;
  // Held until the session's orders have gone (lib/closure-hold.ts), so it may not be sent yet.
  await expect.poll(() => commands.some(({ type }) => type === 'register.closure.submit'), { timeout: 30_000 }).toBe(true);
  const closure = commands.find(({ type }) => type === 'register.closure.submit');
  await expect.poll(() => results.get(closure!.id)?.status, { timeout: 30_000 }).toBe('applied');
  expect(results.get(closure!.id)!.register!.closure).toMatchObject({ expected: { cash: 10452, external: 952 }, variance: { cash: 0 } });
  expect(closure!.payload).toMatchObject({ sessionId: open.payload.sessionId, tillExpected: { cash: 10452, external: 952 }, counted: { cash: 10452 } });
  // Each sale went to the store stamped with the session, and the closure lists both.
  const orders = commands.filter(({ type }) => type === 'order.create');
  expect(new Set(orders.map(({ payload }) => payload.sessionId))).toEqual(new Set([open.payload.sessionId]));
  expect((closure!.payload.orderIds as string[]).length).toBe(2);
  await sheet.getByTestId('closure-done').click();
  await expect(sheet).toHaveCount(0);
  // Closed: the next sale waits for the register to open again.
  await expect(cart.getByTestId('open-register-card')).toBeVisible();
  await expect(cart.getByTestId('pay-cash')).toHaveCount(0);
  await expect(page.getByTestId('register-open-panel')).toHaveCount(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});

test("a closure waits for its session's orders: the Z notes them, the next session sells, and the closure goes after them", async ({ page }) => {
  // Offline, then both outboxes' backoffs, then the sends.
  test.setTimeout(180_000);
  // Offline: every command the till tries to send. Online: each command the store applied, in the order its answer came.
  const attempted: { type: string; sessionId: unknown }[] = [];
  await page.route('**/tally/v1/commands', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    for (const { type, payload } of route.request().postDataJSON().commands as SentCommand[]) attempted.push({ type, sessionId: payload.sessionId });
    return route.abort();
  });
  const answers: SentCommand[][] = [];
  const results = new Map<string, CommandResult>();
  page.on('response', async (response) => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/tally/v1/commands')) return;
    const at = answers.push([]) - 1;
    const sent: SentCommand[] = response.request().postDataJSON().commands;
    for (const result of ((await response.json().catch(() => ({}))).results ?? []) as CommandResult[]) results.set(result.id, result);
    answers[at] = sent.filter(({ id }) => results.get(id)?.status === 'applied');
  });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender');
  const cashSale = async () => {
    await page.getByTestId('product-tile-Tally Fixture Mug').click();
    await cart.getByTestId('pay-cash').click();
    await tender.getByTestId('cash-tendered').locator('input').fill('9.52');
    await tender.getByTestId('tender-complete').click();
    await page.getByTestId('new-sale').click();
  };
  await openRegister(page, '100.00');
  await cashSale();
  await cashSale();
  await expect(page.getByTestId('orders-waiting')).toHaveText('2 orders waiting to send');
  // Counted exactly: €100.00 + 2 × €9.52.
  await page.getByTestId('register-open-panel').click();
  await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
  await page.getByTestId('register-count').getByTestId('count-amount').fill('119.04');
  await page.getByTestId('register-count').getByTestId('count-close').click();
  const sheet = page.getByTestId('closure-sheet');
  await expect(sheet.getByTestId('closure-expected-cash')).toHaveText('Expected €119.04');
  await expect(page.getByTestId('closure-unsynced')).toHaveText('2 orders still syncing');
  await sheet.getByTestId('closure-print').click();
  expect(await page.frameLocator('#vendurepos-print').locator('p').allTextContents())
    .toEqual(expect.arrayContaining(['Cash expected €119.04', 'Cash variance €0.00', '2 orders still syncing']));
  await expect(page.getByTestId('register-closing-pending')).toHaveText('Closing — waiting for 2 orders');
  await sheet.getByTestId('closure-done').click();
  // The till opens its next session and sells at once, while the closure waits.
  await openRegister(page, '50.00');
  await cashSale();
  await expect(page.getByTestId('orders-waiting')).toHaveText('3 orders waiting to send');
  await expect(page.getByTestId('register-closing-pending')).toHaveText('Closing — waiting for 2 orders');
  const firstSession = attempted.find(({ type }) => type === 'register.session.open')!.sessionId;
  expect(attempted.filter(({ type, sessionId }) => type === 'order.create' && sessionId === firstSession).length).toBeGreaterThan(0);
  // Held in the till: the closure never went out while its orders could not.
  expect(attempted.filter(({ type }) => type === 'register.closure.submit')).toEqual([]);
  await page.unroute('**/tally/v1/commands');
  const applied = () => answers.flat();
  await expect(page.getByTestId('orders-waiting')).toHaveCount(0, { timeout: 120_000 });
  // Flushed as the orders drain, not at the end of the register outbox's backoff (by then 8 s or more).
  await expect.poll(() => applied().some(({ type }) => type === 'register.closure.submit'), { timeout: 3_000 }).toBe(true);
  const order = applied().map(({ type, payload }) => `${type}:${payload.sessionId === firstSession ? 1 : 2}`);
  const closureAt = order.indexOf('register.closure.submit:1');
  expect(order.filter((entry) => entry === 'order.create:1')).toHaveLength(2);
  expect(order.lastIndexOf('order.create:1')).toBeLessThan(closureAt);
  const closure = applied()[closureAt];
  expect(results.get(closure.id)!.register!.closure).toMatchObject({ expected: { cash: 11904 }, variance: { cash: 0 } });
  await expect(page.getByTestId('register-closing-pending')).toHaveCount(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});

test('a till update the store rejects shows in the header', async ({ page }) => {
  // The plugin's answer to a second open session on one register, for every register command; orders reach the store.
  await page.route('**/tally/v1/commands', (route) => {
    const commands: SentCommand[] = route.request().method() === 'POST' ? route.request().postDataJSON().commands : [];
    if (!commands.some(({ type }) => type.startsWith('register.'))) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: commands.map(({ id }) => ({
      id, status: 'rejected', error: { code: 'register_session_already_open', message: 'test refusal' },
    })) }) });
  });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  await expect(page.getByTestId('register-sync-notice')).toHaveCount(0);
  await openRegister(page);
  await expect(page.getByTestId('register-sync-notice')).toHaveText('1 till update needs attention · The online store refused it, '
    + "and later till updates wait behind it. Ask the store owner to look at the till's sync log.");
  expect(await cspViolations(page)).toEqual([]);
  expect(cspConsole).toEqual([]);
});

// Below WIDE_MIN_WIDTH Products and Cart are tabs (vendurepos #70): an add confirms in place and never switches tab.
test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 360, height: 780 } });
  // The active tab's fill, bg-background (@tallyui/theme's --color-background, #f8f9fa). Asserted after each switch for
  // TallyUI #350: Playwright waits out the trigger's 150 ms transition.
  const ACTIVE_TAB_FILL = 'rgb(248, 249, 250)';
  // dev/vendure-store/README.md: TALLY-MUG is 2000000000015 in the "barcode" custom field.
  const MUG_BARCODE = '2000000000015';

  async function signInWithBarcodes(page: Page) {
    await page.goto('/');
    await page.getByTestId('sign-in-url').fill(STORE_URL);
    await page.getByTestId('sign-in-email').fill(USERNAME);
    await page.getByTestId('sign-in-password').fill(PASSWORD);
    await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
    await page.getByTestId('sign-in-barcode_field').fill('barcode');
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeVisible();
  }

  /** A keyboard-wedge scan: the code's keys a few ms apart, then Enter, into whatever has the focus. */
  async function wedgeScan(page: Page, code: string) {
    await page.keyboard.type(code, { delay: 5 });
    await page.keyboard.press('Enter');
  }

  test('a scan on the Cart tab adds in place and lights up the line; an unknown code says so on Cart', async ({ page }) => {
    await signInWithBarcodes(page);
    const cartTab = page.getByTestId('tab-cart');
    const cart = page.getByTestId('cart');
    const lineHighlight = cart.getByTestId('cart-line-highlight-TALLY-MUG');
    await cartTab.click();
    await expect(cartTab).toHaveCSS('background-color', ACTIVE_TAB_FILL);
    await expect(cart).toBeVisible();
    // No field has the focus: the Products search is hidden with its tab.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    await wedgeScan(page, MUG_BARCODE);
    await expect(lineHighlight).toBeVisible();
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(cart.getByTestId('cart-line-TALLY-MUG')).toContainText('€8.00');
    await expect(lineHighlight).toHaveCount(0);
    // Still the Cart tab.
    await expect(cart).toBeVisible();
    await expect(page.getByTestId('product-tile-Tally Fixture Mug')).toBeHidden();
    await expect(page.getByTestId('tab-cart-highlight')).toHaveCount(0);
    await wedgeScan(page, '9999999999999');
    await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "9999999999999".');
    await expect(cart).toBeVisible();
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await page.getByTestId('tab-products').click();
    await expect(page.getByTestId('tab-products')).toHaveCSS('background-color', ACTIVE_TAB_FILL);
  });

  test('a scan on the Products tab adds once and lights up the Cart tab; 12 then Enter in a field adds nothing', async ({ page }) => {
    await signInWithBarcodes(page);
    const mug = page.getByTestId('product-tile-Tally Fixture Mug');
    const cartTab = page.getByTestId('tab-cart');
    const highlight = page.getByTestId('tab-cart-highlight');
    const search = page.getByPlaceholder('Search or scan barcode / SKU');
    // Into the focused search field the field's own Enter looks the code up; the listener leaves it be, so one add.
    await expect(search).toBeFocused();
    await wedgeScan(page, MUG_BARCODE);
    await expect(highlight).toBeVisible();
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(search).toHaveValue('');
    await expect(highlight).toHaveCount(0);
    // The cart's quantity is a stepper with no text field, so the typist's 12 then Enter goes into the search (which a
    // submit blurred: React Native's blurOnSubmit).
    await search.click();
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('12');
    await search.fill('');
    await mug.click();
    await expect(cartTab).toHaveText('Cart (2) · €19.04');
    await expect(highlight).toHaveCount(0);
    // Off the field, the listener takes the scan, and its Enter doesn't press the tile the click left focused.
    await wedgeScan(page, MUG_BARCODE);
    await expect(highlight).toBeVisible();
    await expect(cartTab).toHaveText('Cart (3) · €28.56');
    await expect(mug).toBeVisible();
    await cartTab.click();
    await expect(cartTab).toHaveCSS('background-color', ACTIVE_TAB_FILL);
    await expect(page.getByTestId('cart').getByTestId('cart-total')).toHaveText('€28.56');
  });

  // A scan is intent to sell (Front desk, 2026-09-30): it closes the Orders panel, adds, and shows the line lit up. The
  // wide run overrides this describe's viewport to share its helpers.
  for (const width of [360, 1280]) {
    test(`a scan with the Orders panel open closes it and lights up the cart line (${width} px wide)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await signInWithBarcodes(page);
      const panel = page.getByTestId('orders-panel');
      const cart = page.getByTestId('cart');
      // On the Products tab when narrow: the scan switches to Cart because the cashier must see the line.
      await page.getByTestId('orders-open').click();
      await expect(panel).toBeVisible();
      await wedgeScan(page, MUG_BARCODE);
      await expect(cart.getByTestId('cart-line-highlight-TALLY-MUG')).toBeVisible();
      await expect(panel).toHaveCount(0);
      await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
      await expect(page.getByTestId('tab-cart-highlight')).toHaveCount(0);
      // An unknown code closes it too, and says so.
      await page.getByTestId('orders-open').click();
      await expect(panel).toBeVisible();
      await wedgeScan(page, '9999999999999');
      await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "9999999999999".');
      await expect(panel).toHaveCount(0);
      await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeVisible();
    });
  }

  // Front desk, 2026-09-30 (docs/scan-policy.md): with the Register panel open a scan closes it and adds, as for the
  // Orders panel; an unknown code closes it too, so its notice shows.
  for (const width of [360, 1280]) {
    test(`a scan with the Register panel open closes it and lights up the cart line (${width} px wide)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await signInWithBarcodes(page);
      const panel = page.getByTestId('register-panel');
      const cart = page.getByTestId('cart');
      if (width < 768) await page.getByTestId('tab-cart').click();
      await openRegister(page);
      if (width < 768) await page.getByTestId('tab-products').click();
      await page.getByTestId('register-open-panel').click();
      await expect(panel).toBeVisible();
      await wedgeScan(page, MUG_BARCODE);
      await expect(cart.getByTestId('cart-line-highlight-TALLY-MUG')).toBeVisible();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId('tab-cart-highlight')).toHaveCount(0);
      await page.getByTestId('register-open-panel').click();
      await expect(panel).toBeVisible();
      await wedgeScan(page, '9999999999999');
      await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "9999999999999".');
      await expect(panel).toHaveCount(0);
      await expect(cart.getByTestId('cart-line-TALLY-MUG')).toContainText('€8.00');
    });
  }

  test('a scan with a paid-in sheet open: into a field it is typing, off the fields it closes the sheet and adds', async ({ page }) => {
    await signInWithBarcodes(page);
    const cartTab = page.getByTestId('tab-cart');
    const cart = page.getByTestId('cart');
    const panel = page.getByTestId('register-panel');
    const sheet = page.getByTestId('movement-sheet');
    await cartTab.click();
    await openRegister(page);
    await page.getByTestId('register-open-panel').click();
    await panel.getByTestId('register-panel-paid-in').click();
    await expect(sheet).toBeVisible();
    // Into the reason field the keys are the field's: nothing is added.
    await sheet.getByTestId('movement-reason').click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(sheet.getByTestId('movement-reason')).toHaveValue(MUG_BARCODE);
    await expect(sheet).toBeVisible();
    await expect(cartTab).toHaveText('Cart (0) · €0.00');
    // Off the fields, the scan closes the sheet and the panel, and adds.
    await sheet.getByText('Paid in').click();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    await wedgeScan(page, MUG_BARCODE);
    await expect(cart.getByTestId('cart-line-highlight-TALLY-MUG')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    // Closed for good: the panel opens again without it.
    await page.getByTestId('register-open-panel').click();
    await expect(panel).toBeVisible();
    await expect(sheet).toHaveCount(0);
  });

  test('a scan while the register is counting adds nothing and says to finish closing', async ({ page }) => {
    await signInWithBarcodes(page);
    const cartTab = page.getByTestId('tab-cart');
    await cartTab.click();
    await openRegister(page);
    await wedgeScan(page, MUG_BARCODE);
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await page.getByTestId('register-open-panel').click();
    await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
    await expect(page.getByTestId('register-count')).toBeVisible();
    // Off the count's fields, so the listener takes the scan.
    await page.getByTestId('signed-in-store').click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(page.getByTestId('scan-finish-closing')).toHaveText('Finish closing the register before scanning.');
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(page.getByTestId('register-count')).toBeVisible();
  });

  // Front desk, 2026-09-30: a barcode landing in a cash-counted or tendered field is a money error, so a scanner burst
  // into a money field is a scan; typed digits stay typing.
  test('a scan into the counted cash leaves the count as it was and says to finish closing; typed 1-2-0 is 120', async ({ page }) => {
    await signInWithBarcodes(page);
    const cartTab = page.getByTestId('tab-cart');
    await cartTab.click();
    await openRegister(page);
    await wedgeScan(page, MUG_BARCODE);
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await page.getByTestId('register-open-panel').click();
    await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
    const counted = page.getByTestId('register-count').getByTestId('count-amount');
    const finishClosing = page.getByTestId('scan-finish-closing');
    // A cashier's 1, 2, 0 then Enter is typing, and no scan.
    await counted.click();
    await page.keyboard.type('120', { delay: 150 });
    await page.keyboard.press('Enter');
    await expect(counted).toHaveValue('120');
    await expect(finishClosing).toHaveCount(0);
    await expect(page.getByTestId('scan-not-found')).toHaveCount(0);
    // A 12-digit burst is a scan: the count keeps its value. That code is in no catalogue, so the unknown-code row applies.
    // The typed Enter blurred the field (react-native-web's blurOnSubmit), so focus it again.
    await counted.click();
    await wedgeScan(page, '400638133393');
    await expect(page.getByTestId('scan-not-found')).toBeVisible();
    await expect(counted).toHaveValue('120');
    // A catalogue code gets the counting row's notice, and still leaves the count alone.
    await counted.click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(finishClosing).toHaveText('Finish closing the register before scanning.');
    await expect(counted).toHaveValue('120');
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
  });

  // PR #86 review: not even a scan's first key may reach a money field, whose onChangeText a later restore can't undo.
  test('a scan into the counted cash leaves the tile counts as they were', async ({ page }) => {
    await signInWithBarcodes(page);
    await page.getByTestId('tab-cart').click();
    await openRegister(page);
    await wedgeScan(page, MUG_BARCODE);
    await page.getByTestId('register-open-panel').click();
    await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
    const counted = page.getByTestId('register-count').getByTestId('count-amount');
    const fiveTile = page.getByTestId('den-tile-500');
    await fiveTile.click();
    await fiveTile.click();
    await expect(counted).toHaveValue('10.00');
    await expect(page.getByTestId('den-count-500')).toHaveText('2');
    await counted.click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(page.getByTestId('scan-finish-closing')).toBeVisible();
    await expect(counted).toHaveValue('10.00');
    await expect(page.getByTestId('den-count-500')).toHaveText('2');
    await fiveTile.click();
    await expect(counted).toHaveValue('15.00');
  });

  test('a scan into a cleared cash tendered field adds no payment: back to the cart, and the mug is added', async ({ page }) => {
    await signInWithBarcodes(page);
    const cartTab = page.getByTestId('tab-cart');
    const tender = page.getByTestId('tender');
    await cartTab.click();
    await openRegister(page);
    await wedgeScan(page, MUG_BARCODE);
    await page.getByTestId('cart').getByTestId('pay-cash').click();
    const cashInput = tender.getByTestId('cash-tendered').locator('input');
    await cashInput.fill('');
    await expect(cashInput).toHaveValue('');
    await wedgeScan(page, MUG_BARCODE);
    await expect(tender).toHaveCount(0);
    await expect(cartTab).toHaveText('Cart (2) · €19.04');
    await expect(page.getByTestId('scan-finish-sale')).toHaveCount(0);
  });

  // A scan is never silent: over the Z sheet its notice is on top (a trial click's hit test passes), clear of the unsynced note.
  test('a scan while the Z sheet shows adds nothing and says so over the sheet', async ({ page }) => {
    await signInWithBarcodes(page);
    await page.route('**/tally/v1/commands', (route) => route.request().method() === 'POST' ? route.abort() : route.continue());
    const cartTab = page.getByTestId('tab-cart');
    await cartTab.click();
    await openRegister(page);
    await wedgeScan(page, MUG_BARCODE);
    await page.getByTestId('cart').getByTestId('pay-cash').click();
    await page.getByTestId('tender').getByTestId('cash-tendered').locator('input').fill('9.52');
    await page.getByTestId('tender').getByTestId('tender-complete').click();
    await page.getByTestId('new-sale').click();
    await page.getByTestId('register-open-panel').click();
    await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
    await page.getByTestId('register-count').getByTestId('count-amount').fill('109.52');
    await page.getByTestId('register-count').getByTestId('count-close').click();
    await expect(page.getByTestId('closure-unsynced')).toHaveText('1 order still syncing');
    // Off the count's field, into the sheet, so the listener takes the scan.
    await page.getByTestId('closure-title').click();
    await wedgeScan(page, MUG_BARCODE);
    const notice = page.getByTestId('scan-finish-closing');
    await expect(notice).toHaveText('Finish closing the register before scanning.');
    await notice.click({ trial: true, timeout: 5_000 });
    const [note, box] = [await page.getByTestId('closure-unsynced').boundingBox(), await notice.boundingBox()];
    expect(box!.y).toBeGreaterThan(note!.y + note!.height);
    await expect(cartTab).toHaveText('Cart (0) · €0.00');
    await wedgeScan(page, '9999999999999');
    await page.getByTestId('scan-not-found').click({ trial: true, timeout: 5_000 });
  });

  // Front desk, 2026-09-30: a scan at a tender with nothing entered goes back to the cart and adds; with a payment it
  // changes nothing and says so; at the receipt it starts the next sale. An unknown code never leaves the stage.
  test('a scan at a tender or the receipt adds to the cart, unless a payment is entered', async ({ page }) => {
    await signInWithBarcodes(page);
    // The store can't be reached for orders, so the completed sale stays counted as waiting.
    await page.route('**/tally/v1/commands', (route) => route.request().method() === 'POST' ? route.abort() : route.continue());
    const cartTab = page.getByTestId('tab-cart');
    const cart = page.getByTestId('cart');
    const tender = page.getByTestId('tender');
    const receipt = page.getByTestId('receipt');
    const lineHighlight = cart.getByTestId('cart-line-highlight-TALLY-MUG');
    await cartTab.click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(lineHighlight).toHaveCount(0);
    // The scan above added with no session open; Pay waits for the register.
    await openRegister(page);
    // Nothing entered: back to the cart, one more mug, its line lit up.
    await cart.getByTestId('pay-cash').click();
    await expect(tender).toBeVisible();
    await wedgeScan(page, MUG_BARCODE);
    await expect(lineHighlight).toBeVisible();
    await expect(tender).toHaveCount(0);
    await expect(cartTab).toHaveText('Cart (2) · €19.04');
    await expect(cart.getByTestId('cart-line-TALLY-MUG')).toContainText('€16.00');
    // A cash amount entered: the tender, its amount and the cart stay as they are.
    await cart.getByTestId('pay-cash').click();
    const cashInput = tender.getByTestId('cash-tendered').locator('input');
    await cashInput.fill('20.00');
    await expect(tender.getByTestId('tender-change')).toContainText('€0.96');
    // Off the field, so the listener takes the scan.
    await tender.getByTestId('tender-total').click();
    await wedgeScan(page, MUG_BARCODE);
    await expect(page.getByTestId('scan-finish-sale')).toHaveText('Finish this sale before scanning the next item.');
    await expect(tender).toBeVisible();
    await expect(cashInput).toHaveValue('20.00');
    await expect(tender.getByTestId('tender-total')).toHaveText('€19.04');
    await expect(cartTab).toHaveText('Cart (2) · €19.04');
    await tender.getByTestId('tender-complete').click();
    await expect(receipt).toBeVisible();
    await expect(page.getByTestId('scan-finish-sale')).toHaveCount(0);
    await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
    // An unknown code at the receipt only says so.
    await wedgeScan(page, '9999999999999');
    await expect(page.getByTestId('scan-not-found')).toHaveText('No products match "9999999999999".');
    await expect(receipt).toBeVisible();
    // The mug starts the next sale, at quantity 1 and lit up; the stored order is still waiting.
    await wedgeScan(page, MUG_BARCODE);
    await expect(lineHighlight).toBeVisible();
    await expect(receipt).toHaveCount(0);
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(cart.getByTestId(/^cart-line-/)).toHaveCount(1);
    await expect(page.getByTestId('scan-not-found')).toHaveCount(0);
    await expect(page.getByTestId('orders-waiting')).toHaveText('1 order waiting to send');
  });

  test('Products and Cart are tabs: the Cart tab carries the count and total, and tax reads as a breakdown', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('sign-in-url').fill(STORE_URL);
    await page.getByTestId('sign-in-email').fill(USERNAME);
    await page.getByTestId('sign-in-password').fill(PASSWORD);
    await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
    await page.getByTestId('sign-in-submit').click();
    const mug = page.getByTestId('product-tile-Tally Fixture Mug');
    const cart = page.getByTestId('cart');
    const cartTab = page.getByTestId('tab-cart');
    const highlight = page.getByTestId('tab-cart-highlight');
    await expect(mug).toBeVisible();
    // The register opens from the Cart tab, where Pay waits for it; the header's Register button needs no tab.
    await cartTab.click();
    await openRegister(page);
    await page.getByTestId('tab-products').click();
    await expect(page.getByTestId('tab-products')).toHaveText('Products');
    await expect(cartTab).toHaveText('Cart (0) · €0.00');
    await expect(cart).toBeHidden();
    // The mug is €8.00 plus Standard 19 %: €9.52.
    await mug.click();
    await expect(highlight).toBeVisible();
    await expect(cartTab).toHaveText('Cart (1) · €9.52');
    await expect(highlight).toHaveCount(0);
    await expect(mug).toBeVisible();
    await expect(cart.getByTestId('cart-line-TALLY-MUG')).toBeHidden();
    await mug.click();
    await expect(cartTab).toHaveText('Cart (2) · €19.04');
    await expect(mug).toBeVisible();
    await cartTab.click();
    await expect(cartTab).toHaveCSS('background-color', ACTIVE_TAB_FILL);
    await expect(mug).toBeHidden();
    await expect(cart.getByTestId(/^cart-line-/)).toHaveCount(1);
    await expect(cart.getByTestId('cart-line-TALLY-MUG')).toContainText('€16.00');
    await expect(cart.getByTestId('cart-total')).toHaveText('€19.04');
    // Tax first, then its rates under it.
    const taxRows = /^(Tax|incl\. .+)$/;
    await expect(cart.getByText(taxRows)).toHaveText(['Tax', 'incl. Standard DE 19%']);
    await expect(cart.getByTestId('cart-tax')).toHaveText('€3.04');
    await expect(cart.getByTestId('cart-tax-Standard DE 19%')).toHaveText('€3.04');
    await cart.getByTestId('pay-cash').click();
    const tender = page.getByTestId('tender');
    await tender.getByTestId('cash-tendered').locator('input').fill('20.00');
    await tender.getByTestId('tender-complete').click();
    const receipt = page.getByTestId('receipt');
    await expect(receipt.getByTestId('receipt-total')).toHaveText('€19.04');
    await expect(receipt.getByText(taxRows)).toHaveText(['Tax', 'incl. Standard DE 19%']);
    await expect(receipt.getByTestId('receipt-tax-Standard DE 19%')).toHaveText('€3.04');
    await expect(receipt.getByTestId('receipt-change')).toHaveText('€0.96');
    expect(await cspViolations(page)).toEqual([]);
    expect(cspConsole).toEqual([]);
  });
});
