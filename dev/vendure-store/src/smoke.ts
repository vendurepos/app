import { randomUUID } from 'node:crypto';
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

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// One v3 order.create for 1 x TALLY-MUG: 800 net, DK 25 %, tax-exclusive, paid 1000 cash
// (the figures as the plugin's test/payloads.ts derives them).
function mugCommand(variantId: string) {
  const [quantity, unitPriceMinor, ratePpm] = [1, 800, 250_000];
  const netMinor = unitPriceMinor * quantity;
  // Tax-exclusive: the tax is added to the line amount, rounded once (exact here: 200).
  const taxMinor = Math.round(netMinor * ratePpm / 1_000_000);
  const totalMinor = netMinor + taxMinor;
  const createdAt = new Date().toISOString();
  const clientLineId = randomUUID();
  return {
    id: randomUUID(), type: 'order.create', version: 3, createdAt, deviceId: 'dev-store-smoke', attempt: 1,
    payload: {
      clientOrderId: randomUUID(), createdAt, currency: 'EUR', pricesIncludeTax: false,
      lines: [{ clientLineId, variantId, quantity, unitPriceMinor }],
      subtotalMinor: totalMinor - taxMinor, taxMinor, totalMinor,
      payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
      registerId: 'dev-store-smoke', cashierRef: 'dev-store-smoke', sessionId: randomUUID(),
      // The display mode is the order's (tax-exclusive), so each line shows its net amount.
      display: {
        currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor: totalMinor - taxMinor, discountMinor: 0,
        taxMinor, totalMinor, orderDiscountMinor: 0, lines: [{ clientLineId, amountMinor: netMinor, discounts: [] }],
      },
      taxByRate: [{ ratePpm, netMinor, taxMinor, grossMinor: netMinor + taxMinor }],
    },
  };
}

async function commandSmoke(token: string) {
  const admin = { Authorization: `Bearer ${token}`, 'vendure-token': POS_CHANNEL_TOKEN };
  const mug = async () => (await gql('/admin-api', `query Mug($sku: String!) {
    productVariants(options: { filter: { sku: { eq: $sku } } }) {
      items { id stockLevels { stockOnHand stockLocation { name } } }
    }
  }`, { sku: 'TALLY-MUG' }, admin)).body.data.productVariants.items[0] as {
    id: string; stockLevels: Array<{ stockOnHand: number; stockLocation: { name: string } }>;
  };
  const shopFloor = (variant: Awaited<ReturnType<typeof mug>>) =>
    variant.stockLevels.find(level => level.stockLocation.name === 'Shop floor')?.stockOnHand;
  const post = async (body: unknown, headers: Record<string, string> = { 'X-Tally-Protocol': '1' }) => {
    const response = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/tally/v1/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...admin, ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const before = await mug();
  const command = mugCommand(before.id);
  const sold = await post({ commands: [command] });
  expectEqual(sold.status, 200, `the sale's HTTP status (${JSON.stringify(sold.body)})`);
  const result = sold.body.results?.[0];
  expectEqual([result?.id, result?.status, result?.serverRefs?.totalMinor], [command.id, 'applied', 1000], 'the sale\'s result');
  const { order } = (await gql('/admin-api', 'query Order($id: ID!) { order(id: $id) { state totalWithTax } }',
    { id: result.serverRefs.orderId }, admin)).body.data;
  expectEqual(order, { state: 'Delivered', totalWithTax: 1000 }, `order ${result.serverRefs.orderId} in the Admin API`);
  expectEqual(shopFloor(await mug()), shopFloor(before)! - 1, 'the Shop floor stock of TALLY-MUG');
  console.log(`ok - POST /tally/v1/commands applied order ${result.serverRefs.displayId}: Delivered, 1000, Shop floor stock -1`);
  const replay = await post({ commands: [command] });
  expectEqual([replay.status, replay.body.results?.[0]?.status, replay.body.results?.[0]?.serverRefs?.orderId],
    [200, 'duplicate', result.serverRefs.orderId], 'the replay');
  console.log('ok - the replay is duplicate, with the same orderId');
  const malformed = await post({ commands: [mugCommand(before.id)] }, {});
  expectEqual([malformed.status, malformed.body.code], [400, 'unsupported_protocol'], 'a batch without X-Tally-Protocol');
  console.log('ok - a batch without X-Tally-Protocol answers 400');
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
  try {
    if (!token) throw new Error('Admin login did not provide a bearer token');
    await commandSmoke(token);
  } catch (error) {
    failed = true;
    console.error(`not ok - POST /tally/v1/commands: ${error}`);
  }
  if (failed) process.exit(1);
  console.log('smoke: all checks passed');
  process.exit(0);
}

void smoke();
