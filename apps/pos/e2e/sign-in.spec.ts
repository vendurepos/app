import { expect, test } from '@playwright/test';

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
  await page.getByTestId('sign-in-submit').click();
  await expect(page.getByText(/Failed to fetch/).first()).toBeVisible();
  await expect(page.getByText('Tally Fixture Mug', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No products yet.', { exact: true })).toBeVisible();
  await page.unroute('**/admin-api');
  await page.reload();
  await expect(page.getByText('Tally Fixture Mug', { exact: true }).first()).toBeVisible();
});
