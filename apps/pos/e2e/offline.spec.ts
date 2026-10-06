import { expect, test, type Page } from '@playwright/test';

// The MVP acceptance (plan §1, VA7), run by pnpm e2e (scripts/e2e.sh) against its own fresh store on :3100: 25 sales,
// 20 of them offline, land as exactly 25 orders at the POS totals, settled, fulfilled and stamped with the sale time.
const STORE_URL = process.env.E2E_STORE_URL ?? 'http://127.0.0.1:3100';
// dev/vendure-store/src/constants.ts defines POS_CHANNEL_TOKEN, SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD.
const CHANNEL_TOKEN = 'vendurepos-dev-pos';
const USERNAME = 'superadmin';
const PASSWORD = 'superadmin';

// dev/vendure-store/src/catalogue.ts: each SKU's tile, and its variant button when the product has several. Prices
// are tax-exclusive, and one sale takes one group only, so every order is single-rate (no TALLY-ROUNDING).
const PRODUCTS: Record<string, { tile: string; variant?: RegExp }> = {
  'TALLY-MUG': { tile: 'Tally Fixture Mug' }, TOTE: { tile: 'Tote Bag' }, 'POST-SET': { tile: 'Postcard Set' },
  'NOTE-A5': { tile: 'Notebook', variant: /NOTE-A5/ }, 'NOTE-A6': { tile: 'Notebook', variant: /NOTE-A6/ },
  'FIL-500': { tile: 'Filter Coffee' }, 'ESP-250': { tile: 'Espresso Beans', variant: /ESP-250/ },
  'ESP-1000': { tile: 'Espresso Beans', variant: /ESP-1000/ },
};
const STANDARD = ['TALLY-MUG', 'TOTE', 'POST-SET', 'NOTE-A5', 'NOTE-A6'];
const REDUCED = ['FIL-500', 'ESP-250', 'ESP-1000'];

// Sale i: every fourth is Reduced (7 %), the rest Standard (19 %); 1-3 lines, quantities 1-2, cash and card in turn.
// The most any SKU sells is 12 (TOTE, 15 on the Shop floor), so no sale needs a stock top-up.
function mix(i: number) {
  const group = i % 4 === 3 ? REDUCED : STANDARD;
  const lines = Array.from({ length: Math.min(1 + (i % 3), group.length) }, (_, j) => ({
    sku: group[(i + j) % group.length], quantity: 1 + ((i + j) % 2),
  }));
  return { lines, method: i % 2 ? 'card' : 'cash' };
}

type Sale = ReturnType<typeof mix> & { total: number; startedAt: number; endedAt: number };
type Command = { id: string; type: string; payload: { clientOrderId: string; createdAt: string; totalMinor: number } };

async function admin(page: Page, token: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await page.request.post(`${STORE_URL}/admin-api`, {
    headers: { Authorization: `Bearer ${token}`, 'vendure-token': CHANNEL_TOKEN }, data: { query, variables },
  });
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  return body.data;
}

// The Shop floor's stockOnHand (the POS channel's only stock location) for each SKU.
async function shopFloor(page: Page, token: string, skus: string[]) {
  const { productVariants } = await admin(page, token, `query ($skus: [String!]) { productVariants(options: { take: 100,
    filter: { sku: { in: $skus } } }) { items { sku stockLevels { stockOnHand stockLocation { name } } } } }`, { skus });
  return Object.fromEntries(productVariants.items.map((variant: { sku: string; stockLevels: { stockOnHand: number; stockLocation: { name: string } }[] }) =>
    [variant.sku, variant.stockLevels.find((level) => level.stockLocation.name === 'Shop floor')!.stockOnHand]));
}

test('25 sales, 20 offline: 25 orders, none duplicated, at the POS totals, settled, fulfilled, and the stock drops', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  // "Offline" aborts every request to the store as a dropped connection does, while the export's own origin stays
  // up. Every order.create the till tries to send, through or not, is recorded with the time it reached the route.
  let offline = false;
  const attempts: { command: Command; passed: boolean; at: number }[] = [];
  await page.route(`${STORE_URL}/**`, (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.url().endsWith('/tally/v1/commands')) {
      for (const command of request.postDataJSON().commands as Command[]) {
        if (command.type === 'order.create') attempts.push({ command, passed: !offline, at: Date.now() });
      }
    }
    return offline ? route.abort('internetdisconnected') : route.continue();
  });
  // The export is served as hosting will serve it: the CSP as a response header, frame-ancestors included.
  // On every response, scripts included: a worker takes its policy from its own script response (Front desk VA8 ruling).
  const script = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('.js'));
  const served = await page.goto('/');
  expect(served!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect((await script).headers()['content-security-policy']).toContain("'wasm-unsafe-eval'");
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  const token = JSON.parse((await page.evaluate(() => localStorage.getItem('vendurepos.session')))!).token;
  const ordersBefore = (await admin(page, token, '{ orders(options: { take: 1 }) { totalItems } }')).orders.totalItems;
  const stockBefore = await shopFloor(page, token, Object.keys(PRODUCTS));
  const card = page.getByTestId('open-register-card');
  await expect(card.getByTestId('open-register-amount')).toBeVisible();
  await card.getByTestId('open-register-amount').fill('100.00');
  await card.getByTestId('open-register-button').click();
  await expect(card).toHaveCount(0);

  const cart = page.getByTestId('cart');
  const tender = page.getByTestId('tender');
  const receipt = page.getByTestId('receipt');
  const sales: Sale[] = [];
  const sell = async (i: number) => {
    const { lines, method } = mix(i);
    for (const { sku, quantity } of lines) {
      await page.getByTestId(`product-tile-${PRODUCTS[sku].tile}`).click();
      if (PRODUCTS[sku].variant) await page.getByRole('button', { name: PRODUCTS[sku].variant }).click();
      const line = cart.getByTestId(`cart-line-${sku}`);
      await expect(line).toBeVisible();
      if (quantity === 2) await line.getByText('+', { exact: true }).click();
    }
    await expect(cart.getByTestId(/^cart-line-/)).toHaveCount(lines.length);
    const startedAt = Date.now();
    await cart.getByTestId(`pay-${method}`).click();
    if (method === 'cash') {
      await tender.getByTestId('cash-tendered').locator('input')
        .fill((await tender.getByTestId('tender-total').innerText()).replace(/[^\d.]/g, ''));
    }
    await tender.getByTestId('tender-complete').click();
    // The POS total is the receipt's, in minor units.
    const total = Math.round(Number((await receipt.getByTestId('receipt-total').innerText()).replace(/[^\d.]/g, '')) * 100);
    sales.push({ lines, method, total, startedAt, endedAt: Date.now() });
    await receipt.getByTestId('new-sale').click();
    await expect(cart.getByTestId(/^cart-line-/)).toHaveCount(0);
  };

  const onlineStart = Date.now();
  for (let i = 0; i < 5; i++) await sell(i);
  await expect(page.getByTestId('sync-status')).toHaveCount(0, { timeout: 30_000 });
  const offlineStart = Date.now();
  offline = true;
  for (let i = 5; i < 25; i++) await sell(i);
  await expect(page.getByTestId('sync-status')).toContainText('20 sales waiting to sync');
  const reconnectedAt = Date.now();
  offline = false;
  // At most the outbox's 60 s backoff cap after the reconnect, then the sends.
  await expect(page.getByTestId('sync-status')).toHaveCount(0, { timeout: 120_000 });
  const drainedAt = Date.now();
  const timings = { onlineSalesMs: offlineStart - onlineStart, offlineSalesMs: reconnectedAt - offlineStart, drainMs: drainedAt - reconnectedAt };
  console.log(`offline e2e timings: ${JSON.stringify(timings)}`);
  test.info().annotations.push({ type: 'timings', description: JSON.stringify(timings) });

  // Each sale's client order id: the orders the till sent, in the order they were sold (their createdAt).
  const commands = new Map(attempts.map(({ command }) => [command.payload.clientOrderId, command]));
  const ids = [...commands.values()].sort((a, b) => Date.parse(a.payload.createdAt) - Date.parse(b.payload.createdAt))
    .map((command) => command.payload.clientOrderId);
  expect(ids).toHaveLength(25);
  expect(ids.map((id) => commands.get(id)!.payload.totalMinor)).toEqual(sales.map(({ total }) => total));
  // The first 5 went through while online; the other 20 were queued offline, none through before the reconnect.
  const throughOnline = new Set(attempts.filter(({ passed, at }) => passed && at < reconnectedAt).map(({ command }) => command.payload.clientOrderId));
  expect(ids.map((id) => throughOnline.has(id))).toEqual(sales.map((_, i) => i < 5));

  const { orders } = await admin(page, token, `query ($ids: [String!]) { orders(options: { take: 100,
    filter: { tallyClientOrderId: { in: $ids } } }) { items { state totalWithTax customFields { tallyClientOrderId tallySaleAt }
    payments { method amount state } fulfillments { state } surcharges { sku } lines { quantity productVariant { sku } }
    history(options: { take: 100 }) { items { type data } } } } }`, { ids });
  // Exactly the 25, and no other order created while the test ran.
  expect((await admin(page, token, '{ orders(options: { take: 1 }) { totalItems } }')).orders.totalItems - ordersBefore).toBe(25);
  expect(orders.items).toHaveLength(25);
  const byId = new Map(orders.items.map((order: { customFields: { tallyClientOrderId: string } }) => [order.customFields.tallyClientOrderId, order]));
  expect(byId.size).toBe(25);
  type Order = {
    state: string; totalWithTax: number; customFields: { tallySaleAt: string }; payments: unknown[]; fulfillments: { state: string }[];
    surcharges: { sku: string }[]; lines: { quantity: number; productVariant: { sku: string } }[]; history: { items: { type: string; data: { to?: string } }[] };
  };
  const landed = ids.map((id, i) => {
    const order = byId.get(id) as Order;
    const saleAt = Date.parse(order.customFields.tallySaleAt);
    return {
      id, total: order.totalWithTax, state: order.state, payments: order.payments,
      settled: order.history.items.some(({ type, data }) => type === 'ORDER_STATE_TRANSITION' && data.to === 'PaymentSettled'),
      fulfillments: order.fulfillments.map(({ state }) => state),
      rounding: order.surcharges.filter(({ sku }) => sku === 'TALLY-ROUNDING'),
      lines: order.lines.map(({ quantity, productVariant }) => ({ sku: productVariant.sku, quantity })),
      // The sale's own time, not the drain's: within the second of the tender's completion.
      saleAtIsSaleTime: saleAt >= sales[i].startedAt - 1000 && saleAt <= sales[i].endedAt + 1000,
    };
  });
  // Settled, then fulfilled: Vendure moves a PaymentSettled order to Delivered when its fulfilment is delivered.
  expect(landed).toEqual(ids.map((id, i) => ({
    id, total: sales[i].total, state: 'Delivered', payments: [{ method: 'tally-pos', amount: sales[i].total, state: 'Settled' }],
    settled: true, fulfillments: ['Delivered'], rounding: [], lines: expect.arrayContaining(sales[i].lines), saleAtIsSaleTime: true,
  })));
  for (const [i, order] of landed.entries()) expect(order.lines).toHaveLength(sales[i].lines.length);

  // Every variant sold: its Shop floor stock dropped by exactly the quantity sold.
  const sold: Record<string, number> = {};
  for (const { lines } of sales) for (const { sku, quantity } of lines) sold[sku] = (sold[sku] ?? 0) + quantity;
  const stockAfter = await shopFloor(page, token, Object.keys(sold));
  expect(Object.fromEntries(Object.keys(sold).map((sku) => [sku, stockBefore[sku] - stockAfter[sku]]))).toEqual(sold);
  expect(violations).toEqual([]);
});
