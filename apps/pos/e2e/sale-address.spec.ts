import { expect, test, type Page } from '@playwright/test';
import { checkout, takePayment } from './checkout';
import { openRegister } from './register';

// scripts/e2e.sh provides E2E_STORE_URL (the e2e store on :3100).
const STORE_URL = process.env.E2E_STORE_URL ?? 'http://127.0.0.1:3100';
// dev/vendure-store/src/constants.ts defines POS_CHANNEL_TOKEN, SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD.
const CHANNEL_TOKEN = 'vendurepos-dev-pos';
const USERNAME = 'superadmin';
const PASSWORD = 'superadmin';
// apps/pos/lib/sale-address.ts and store-health.ts own these sentences; keep app code out of the e2e.
const ADDRESS_ZONE_BLOCK_TEXT = "This store taxes by the customer's address, and this address is outside the till's tax zone. Remove the address to take payment.";
const TAX_ZONE_REFUSED_TEXT = "Refused by the store — the customer's address is in another tax zone. Send it without the address.";
// A default billing and shipping address in Denmark: outside the e2e store's default tax zone, Germany (dev/vendure-store/src/seed.ts).
const DK_ADDRESS = { fullName: 'Dana Zone', streetLine1: '1 Havnegade', city: 'Copenhagen', postalCode: '1058', countryCode: 'DK' };
const PIN_TEXT = '1 Havnegade, Copenhagen, DK';

type Sent = { id: string; type: string; payload: { clientOrderId: string; customer?: { shipping?: unknown } } };

/**
 * Signs in, opens the register, makes a customer with the DK default address and puts the mug in the cart. Every
 * order.create the till sends is collected, so a sale's client order id is known.
 */
async function sellToDkCustomer(page: Page) {
  const sent: Sent[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/tally/v1/commands')) return;
    sent.push(...(request.postDataJSON().commands as Sent[]).filter(({ type }) => type === 'order.create'));
  });
  await page.goto('/');
  await page.getByTestId('sign-in-url').fill(STORE_URL);
  await page.getByTestId('sign-in-email').fill(USERNAME);
  await page.getByTestId('sign-in-password').fill(PASSWORD);
  await page.getByTestId('sign-in-channel_token').fill(CHANNEL_TOKEN);
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByTestId('signed-in-store')).toHaveText(`Signed in to ${STORE_URL}`);
  await openRegister(page);
  const token = JSON.parse((await page.evaluate(() => localStorage.getItem('vendurepos.session')))!).token;
  const admin = async (query: string, variables: Record<string, unknown>) => {
    const response = await page.request.post(`${STORE_URL}/admin-api`, {
      headers: { Authorization: `Bearer ${token}`, 'vendure-token': CHANNEL_TOKEN }, data: { query, variables },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return body.data;
  };
  const email = `sale-address-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { createCustomer: { id } } = await admin('mutation ($input: CreateCustomerInput!) { createCustomer(input: $input) { ... on Customer { id } } }',
    { input: { emailAddress: email, firstName: 'Dana', lastName: 'Zone' } });
  await admin('mutation ($id: ID!, $input: CreateAddressInput!) { createCustomerAddress(customerId: $id, input: $input) { id } }',
    { id, input: { ...DK_ADDRESS, defaultBillingAddress: true, defaultShippingAddress: true } });
  await page.getByTestId('product-tile-Tally Fixture Mug').click();
  await expect(page.getByTestId('cart').getByTestId('cart-line-TALLY-MUG')).toBeVisible();
  const pickCustomer = async () => {
    await page.getByTestId('customer-chip').click();
    const picker = page.getByTestId('customer-picker');
    await picker.getByLabel('Search customers', { exact: true }).fill(email);
    await picker.getByText(email, { exact: true }).click();
    await expect(page.getByTestId('sale-customer')).toHaveText('Dana Zone');
  };
  // Pays the cart in cash and resolves to the sale's client order id, once the till has sent it.
  const pay = async () => {
    const before = sent.length;
    await checkout(page);
    await takePayment(page);
    await page.getByTestId('tender-pane').getByTestId('tender-complete').click();
    await expect(page.getByTestId('receipt')).toBeVisible();
    await expect.poll(() => sent.length).toBeGreaterThan(before);
    return sent[before].payload.clientOrderId;
  };
  // The Admin API's tallyClientOrderId is the order's id: polled until the real store has applied it.
  const storeOrder = async (orderId: string) => {
    const query = `query ($id: String!) { orders(options: { filter: { tallyClientOrderId: { eq: $id } } }) {
      items { shippingAddress { streetLine1 countryCode } billingAddress { streetLine1 countryCode } } } }`;
    let items: { shippingAddress: Record<string, string | null>; billingAddress: Record<string, string | null> }[] = [];
    await expect.poll(async () => (items = (await admin(query, { id: orderId })).orders.items).length, { timeout: 30_000 }).toBe(1);
    return items[0];
  };
  return { sent, pickCustomer, pay, storeOrder };
}

test('e1: a store that does not tax by address takes the DK customer\'s default address onto the order', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const { pickCustomer, pay, storeOrder } = await sellToDkCustomer(page);
  await pickCustomer();
  await expect(page.getByTestId('sale-address')).toHaveText(PIN_TEXT);
  await expect(page.getByTestId('sale-address-edit')).toBeVisible();
  await expect(page.getByTestId('address-block')).toHaveCount(0);
  const order = await storeOrder(await pay());
  expect(order.shippingAddress).toEqual({ streetLine1: '1 Havnegade', countryCode: 'DK' });
});

test('e2: a store that taxes by address blocks checkout for an address outside the zone until it is removed', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const countries: unknown[] = [];
  await page.route('**/tally/v1/info', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    countries.push(body.taxZone?.countries);
    await route.fulfill({ response, json: { ...body, taxZone: { ...body.taxZone, byAddress: true } } });
  });
  const { pickCustomer, pay, storeOrder } = await sellToDkCustomer(page);
  expect(countries.length).toBeGreaterThan(0);
  expect(countries.every((list) => JSON.stringify(list) === JSON.stringify(['DE']))).toBe(true);
  await pickCustomer();
  const cart = page.getByTestId('cart');
  await expect(cart.getByTestId('address-block')).toHaveText(ADDRESS_ZONE_BLOCK_TEXT);
  await expect(cart.getByTestId('checkout')).toHaveCount(0);
  await cart.getByTestId('address-block-remove').click();
  await expect(cart.getByTestId('address-block')).toHaveCount(0);
  await expect(cart.getByTestId('checkout')).toBeVisible();
  await expect(page.getByTestId('sale-address')).toHaveCount(0);
  await expect(page.getByTestId('sale-address-add')).toBeVisible();
  const order = await storeOrder(await pay());
  expect(order.shippingAddress.streetLine1 ?? null).toBeNull();
  expect(order.billingAddress.streetLine1 ?? null).toBeNull();
});

test('e3: /info without taxZone leaves the pin empty', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await page.route('**/tally/v1/info', async (route) => {
    const response = await route.fetch();
    const { taxZone: _taxZone, ...body } = await response.json();
    await route.fulfill({ response, json: body });
  });
  const { pickCustomer } = await sellToDkCustomer(page);
  await pickCustomer();
  await expect(page.getByTestId('sale-address-add')).toBeVisible();
  await expect(page.getByTestId('sale-address')).toHaveCount(0);
});

test('e4: a tax_zone_mismatch refusal is sent again without the address from Store health, and the store applies it', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const { pickCustomer, pay, storeOrder } = await sellToDkCustomer(page);
  // The plugin's real refusal, for the first sale that carries a shipping address; every later send reaches the store.
  let refused: string | undefined;
  const refuse = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    const commands: Sent[] = route.request().method() === 'POST' ? route.request().postDataJSON().commands : [];
    const sale = commands.find(({ type, payload }) => type === 'order.create' && payload.customer?.shipping);
    if (refused || !sale || commands.length !== 1) return route.continue();
    refused = sale.payload.clientOrderId;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{
      id: sale.id, status: 'rejected', error: { code: 'tax_zone_mismatch', message: "The sale's address puts it in tax zone Denmark, but the till priced it in Germany",
        data: { tillZone: 'Germany', addressZone: 'Denmark' } },
    }] }) });
    await page.unroute('**/tally/v1/commands', refuse);
  };
  await page.route('**/tally/v1/commands', refuse);
  await pickCustomer();
  await expect(page.getByTestId('sale-address')).toHaveText(PIN_TEXT);
  const orderId = await pay();
  await expect.poll(() => refused).toBe(orderId);
  await page.getByTestId('new-sale').click();
  await page.getByTestId('store-health-open').click();
  const row = page.getByTestId('store-health-attention').getByTestId(`store-health-attention-${orderId}`);
  await expect(row).toContainText(TAX_ZONE_REFUSED_TEXT);
  await page.getByTestId(`store-health-attention-send-without-address-${orderId}`).click();
  const order = await storeOrder(orderId);
  expect(order.shippingAddress.streetLine1 ?? null).toBeNull();
  expect(order.billingAddress.streetLine1 ?? null).toBeNull();
});
