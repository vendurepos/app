import { PRODUCT_COUNT, VARIANT_COUNT, barcodeOf } from './catalogue';
import {
  POS_CHANNEL_CODE, POS_CHANNEL_TOKEN, SERVER_HOST, SERVER_PORT, SUPERADMIN_PASSWORD, SUPERADMIN_USERNAME,
} from './constants';

async function gql(path: string, query: string, variables = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return { body, headers: response.headers };
}

async function smoke() {
  let failed = false;
  let token: string | null = null;
  try {
    const { body } = await gql('/shop-api', `{
      products(options: { take: 100 }) {
        totalItems items { slug variants { sku price currencyCode customFields { barcode } } }
      }
    }`, {}, { 'vendure-token': POS_CHANNEL_TOKEN });
    const products = body.data.products;
    const mug = products.items.flatMap((product: { variants: Array<{
      sku: string; price: number; currencyCode: string; customFields: { barcode: string };
    }> }) => product.variants).find((variant: { sku: string }) => variant.sku === 'TALLY-MUG');
    if (products.totalItems !== PRODUCT_COUNT || mug?.price !== 800 ||
        mug?.currencyCode !== 'EUR' || mug?.customFields?.barcode !== barcodeOf(0)) {
      throw new Error(`Unexpected catalogue: ${JSON.stringify(products)}`);
    }
    console.log('ok - Shop API product query');
  } catch (error) {
    failed = true;
    console.error(`not ok - Shop API product query: ${error}`);
  }
  try {
    const { body, headers } = await gql('/admin-api', `
      mutation Login($username: String!, $password: String!) {
        login(username: $username, password: $password) {
          ... on CurrentUser { identifier }
          ... on ErrorResult { errorCode message }
        }
      }
    `, { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD });
    token = headers.get('vendure-auth-token');
    if (body.data.login.identifier !== SUPERADMIN_USERNAME || !token) {
      throw new Error(`Unexpected login result or missing auth token: ${JSON.stringify(body.data.login)}`);
    }
    console.log('ok - Admin API login');
  } catch (error) {
    failed = true;
    console.error(`not ok - Admin API login: ${error}`);
  }
  try {
    if (!token) throw new Error('Admin login did not provide a bearer token');
    const { body } = await gql('/admin-api', `{
      activeChannel { code currencyCode pricesIncludeTax defaultTaxZone { name } }
      productVariants(options: { take: 1 }) { totalItems }
      taxRates(options: { take: 50 }) { items { value zone { name } category { name } } }
      stockLocations { items { name } }
    }`, {}, { Authorization: `Bearer ${token}`, 'vendure-token': POS_CHANNEL_TOKEN });
    const { activeChannel: channel, productVariants, taxRates, stockLocations } = body.data;
    const rates = taxRates.items.map((rate: { value: number; zone: { name: string }; category: { name: string } }) =>
      `${rate.category.name}/${rate.zone.name}/${rate.value}`);
    if (channel.code !== POS_CHANNEL_CODE || channel.currencyCode !== 'EUR' || channel.pricesIncludeTax !== false ||
        channel.defaultTaxZone?.name !== 'Denmark' || productVariants.totalItems !== VARIANT_COUNT ||
        !['Standard/Denmark/25', 'Standard/Germany/19', 'Reduced/Denmark/25', 'Reduced/Germany/7']
          .every(rate => rates.includes(rate)) ||
        !stockLocations.items.some((location: { name: string }) => location.name === 'Shop floor')) {
      throw new Error(`Unexpected POS configuration: ${JSON.stringify(body.data)}`);
    }
    console.log('ok - Admin API with the bearer token on the POS channel');
  } catch (error) {
    failed = true;
    console.error(`not ok - Admin API with the bearer token on the POS channel: ${error}`);
  }
  if (failed) process.exit(1);
  console.log('smoke: all checks passed');
  process.exit(0);
}

void smoke();
