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

// One v3 order.create for tax-exclusive lines at one rate, paid in cash, with the figures by the
// till's rule (@tallyui/pos order-builder): each line's net is exact, the tax is rounded once per order.
function saleCommand(lines: Array<{ variantId: string; quantity: number; unitPriceMinor: number }>, ratePpm: number) {
  const posLines = lines.map(line => ({ clientLineId: randomUUID(), ...line }));
  const netMinor = posLines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  // Half away from zero: Math.round is that for these positive amounts.
  const taxMinor = Math.round(netMinor * ratePpm / 1_000_000);
  const totalMinor = netMinor + taxMinor;
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(), type: 'order.create', version: 3, createdAt, deviceId: 'dev-store-smoke', attempt: 1,
    payload: {
      clientOrderId: randomUUID(), createdAt, currency: 'EUR', pricesIncludeTax: false,
      lines: posLines,
      subtotalMinor: totalMinor - taxMinor, taxMinor, totalMinor,
      payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
      registerId: 'dev-store-smoke', cashierRef: 'dev-store-smoke', sessionId: randomUUID(),
      // The display mode is the order's (tax-exclusive), so each line shows its net amount.
      display: {
        currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor: totalMinor - taxMinor, discountMinor: 0,
        taxMinor, totalMinor, orderDiscountMinor: 0, lines: posLines.map(({ clientLineId, unitPriceMinor, quantity }) =>
          ({ clientLineId, amountMinor: unitPriceMinor * quantity, discounts: [] })),
      },
      taxByRate: [{ ratePpm, netMinor, taxMinor, grossMinor: netMinor + taxMinor }],
    },
  };
}

// v5 uses the same tax-exclusive figures, with fees/shipping included in each rate's net before rounding.
function v5Command(lines: Array<{
  variantId?: string; quantity: number; unitPriceMinor: number;
  custom?: { name: string; taxStatus: 'taxable' | 'none'; taxClass?: string };
}>, extras: {
  fees?: Array<{ name: string; amountMinor: number; taxStatus: 'taxable' | 'none'; taxClass?: string }>;
  shipping?: Array<{ name: string; methodId?: string; amountMinor: number; taxStatus: 'taxable' | 'none'; taxClass?: string }>;
}) {
  // The dev store's default is Standard (DE 19 %); Reduced is DE 7 %, and untaxed custom lines are 0 %.
  const ratePpm = (tax?: { taxStatus: string; taxClass?: string }) =>
    tax?.taxStatus === 'none' ? 0 : tax?.taxClass === 'Reduced' ? 70_000 : 190_000;
  const posLines = lines.map(line => ({ clientLineId: randomUUID(), ...line }));
  const fees = extras.fees?.map(fee => ({ clientFeeId: randomUUID(), ...fee,
    taxMinor: Math.round(fee.amountMinor * ratePpm(fee) / 1_000_000) }));
  const shipping = extras.shipping?.map(charge => ({ clientShippingId: randomUUID(), ...charge,
    taxMinor: Math.round(charge.amountMinor * ratePpm(charge) / 1_000_000) }));
  const figures = [
    ...posLines.map(line => ({ netMinor: line.unitPriceMinor * line.quantity, ratePpm: ratePpm(line.custom) })),
    ...[...(fees ?? []), ...(shipping ?? [])].map(charge => ({ netMinor: charge.amountMinor, ratePpm: ratePpm(charge) })),
  ];
  const taxByRate = [...new Set(figures.map(figure => figure.ratePpm))].map(ratePpm => {
    const netMinor = figures.filter(figure => figure.ratePpm === ratePpm).reduce((sum, figure) => sum + figure.netMinor, 0);
    const taxMinor = Math.round(netMinor * ratePpm / 1_000_000);
    return { ratePpm, netMinor, taxMinor, grossMinor: netMinor + taxMinor };
  });
  // Subtotal is the lines' net; the display lists fees and shipping separately.
  const subtotalMinor = posLines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  const taxMinor = taxByRate.reduce((sum, rate) => sum + rate.taxMinor, 0);
  const totalMinor = taxByRate.reduce((sum, rate) => sum + rate.grossMinor, 0);
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(), type: 'order.create', version: 5, createdAt, deviceId: 'dev-store-smoke', attempt: 1,
    payload: {
      clientOrderId: randomUUID(), createdAt, currency: 'EUR', pricesIncludeTax: false,
      lines: posLines, fees, shipping, subtotalMinor, taxMinor, totalMinor,
      payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
      registerId: 'dev-store-smoke', cashierRef: 'dev-store-smoke', sessionId: randomUUID(),
      display: {
        currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor, discountMinor: 0,
        taxMinor, totalMinor, orderDiscountMinor: 0, lines: posLines.map(({ clientLineId, unitPriceMinor, quantity }) =>
          ({ clientLineId, amountMinor: unitPriceMinor * quantity, discounts: [] })),
        fees: fees?.map(({ clientFeeId, amountMinor }) => ({ clientFeeId, amountMinor })),
        shipping: shipping?.map(({ clientShippingId, amountMinor }) => ({ clientShippingId, amountMinor })),
      },
      taxByRate,
    },
  };
}

// 1 x TALLY-MUG: 800 net, DE 19 % (152), paid 952 cash.
const mugCommand = (variantId: string) => saleCommand([{ variantId, quantity: 1, unitPriceMinor: 800 }], 190_000);

async function commandSmoke(token: string) {
  const admin = { Authorization: `Bearer ${token}`, 'vendure-token': POS_CHANNEL_TOKEN };
  const variant = async (sku: string) => (await gql('/admin-api', `query Variant($sku: String!) {
    productVariants(options: { filter: { sku: { eq: $sku } } }) {
      items { id stockLevels { stockOnHand stockLocation { name } } }
    }
  }`, { sku }, admin)).body.data.productVariants.items[0] as {
    id: string; stockLevels: Array<{ stockOnHand: number; stockLocation: { name: string } }>;
  };
  const mug = () => variant('TALLY-MUG');
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
  expectEqual([result?.id, result?.status, result?.serverRefs?.totalMinor], [command.id, 'applied', 952], 'the sale\'s result');
  expectEqual([result?.warnings, result?.totalWarnings], [undefined, undefined], 'the sale\'s warnings');
  const { order } = (await gql('/admin-api', 'query Order($id: ID!) { order(id: $id) { state totalWithTax } }',
    { id: result.serverRefs.orderId }, admin)).body.data;
  expectEqual(order, { state: 'Delivered', totalWithTax: 952 }, `order ${result.serverRefs.orderId} in the Admin API`);
  expectEqual(shopFloor(await mug()), shopFloor(before)! - 1, 'the Shop floor stock of TALLY-MUG');
  console.log(`ok - POST /tally/v1/commands applied order ${result.serverRefs.displayId}: Delivered, 952, no warnings, Shop floor stock -1`);
  const replay = await post({ commands: [command] });
  expectEqual([replay.status, replay.body.results?.[0]?.status, replay.body.results?.[0]?.serverRefs?.orderId],
    [200, 'duplicate', result.serverRefs.orderId], 'the replay');
  console.log('ok - the replay is duplicate, with the same orderId');
  const malformed = await post({ commands: [mugCommand(before.id)] }, {});
  expectEqual([malformed.status, malformed.body.code], [400, 'unsupported_protocol'], 'a batch without X-Tally-Protocol');
  console.log('ok - a batch without X-Tally-Protocol answers 400');
  // The parity claim (PLAN.md): on a single-rate order the till's tax (rounded once per order) equals
  // OrderLevelTaxCalculationStrategy's (rounded once per rate group), so no TALLY-ROUNDING bridge.
  const baskets: Array<[string, number, Array<[string, number, number]>]> = [
    // Per-line rounding gives a different tax here, so this could not pass under the default strategy.
    // Standard 19 %: per line 94.81 -> 95, 132.81 -> 133, 113.81 -> 114 = 342; per order 1797 x 19 % = 341.43 -> 341.
    ['Standard', 190_000, [['NOTE-A6', 1, 499], ['NOTE-A5', 1, 699], ['POST-SET', 1, 599]]],
    // Per-line rounding gives a different tax here, so this could not pass under the default strategy.
    // Reduced 7 %: per line 188.79 -> 189, 419.86 -> 420, 272.79 -> 273 = 882; per order 12592 x 7 % = 881.44 -> 881.
    ['Reduced', 70_000, [['ESP-250', 3, 899], ['ESP-1000', 2, 2999], ['FIL-500', 3, 1299]]],
  ];
  for (const [category, ratePpm, basket] of baskets) {
    const lines = await Promise.all(basket.map(async ([sku, quantity, unitPriceMinor]) =>
      ({ variantId: (await variant(sku)).id, quantity, unitPriceMinor })));
    const sale = saleCommand(lines, ratePpm);
    const response = await post({ commands: [sale] });
    const applied = response.body.results?.[0];
    expectEqual([response.status, applied?.status, applied?.serverRefs?.totalMinor], [200, 'applied', sale.payload.totalMinor],
      `the ${category} parity sale's result (${JSON.stringify(response.body)})`);
    expectEqual([applied?.warnings, applied?.totalWarnings], [undefined, undefined], `the ${category} parity sale's warnings`);
    console.log(`ok - a ${basket.length}-line ${category} sale at ${ratePpm / 10_000} % is applied at the till's ` +
      `${sale.payload.totalMinor} (tax ${sale.payload.taxMinor}), no warnings`);
  }
  const mugLine = { variantId: before.id, quantity: 1, unitPriceMinor: 800 };
  for (const [name, sale, totalMinor] of [
    // Bag: 800 + 20 net, round(820 × 19 %) = 156 tax, total 976.
    ['fee', v5Command([mugLine], { fees: [{ name: 'Bag', amountMinor: 20, taxStatus: 'taxable' }] }), 976],
    // Shipping: mug 800 + 152 tax, delivery 500 + 35 tax at 7 %, total 1487.
    ['shipping', v5Command([mugLine], { shipping: [{ name: 'Local delivery', methodId: 'flat_rate',
      amountMinor: 500, taxStatus: 'taxable', taxClass: 'Reduced' }] }), 1487],
    // Custom: mug 800 + 152 tax, Gift wrap 2 × 300 at 0 %, total 1552.
    ['custom line', v5Command([mugLine, { quantity: 2, unitPriceMinor: 300,
      custom: { name: 'Gift wrap', taxStatus: 'none' } }], {}), 1552],
  ] as const) {
    expectEqual(sale.payload.totalMinor, totalMinor, `the v5 ${name} till total`);
    const response = await post({ commands: [sale] });
    const applied = response.body.results?.[0];
    expectEqual([response.status, applied?.status, applied?.serverRefs?.totalMinor], [200, 'applied', totalMinor],
      `the v5 ${name} sale's result (${JSON.stringify(response.body)})`);
    expectEqual([applied?.warnings, applied?.totalWarnings], [undefined, undefined], `the v5 ${name} sale's warnings`);
    const { order } = (await gql('/admin-api', `query Order($id: ID!) {
      order(id: $id) { totalWithTax shippingWithTax surcharges { sku price }
        lines { productVariant { sku } customFields { tallyCustomName } linePrice linePriceWithTax }
      }
    }`, { id: applied.serverRefs.orderId }, admin)).body.data;
    expectEqual(order.totalWithTax, totalMinor, `the v5 ${name} Admin API total`);
    if (name === 'fee') {
      expectEqual(order.surcharges.filter((charge: { sku: string }) => charge.sku === 'TALLY-FEE'),
        [{ sku: 'TALLY-FEE', price: 20 }], 'the Bag surcharge net');
    } else if (name === 'shipping') {
      expectEqual(order.shippingWithTax, 535, 'the shipping charge with 7 % tax');
    } else {
      expectEqual(order.lines.find((line: { productVariant: { sku: string } }) => line.productVariant.sku === 'TALLY-CUSTOM-ITEM'),
        { productVariant: { sku: 'TALLY-CUSTOM-ITEM' }, customFields: { tallyCustomName: 'Gift wrap' },
          linePrice: 600, linePriceWithTax: 600 }, 'the untaxed Gift wrap line');
    }
    console.log(`ok - v5 ${name} applied at the till's ${totalMinor}, no warnings, checked in the Admin API`);
  }
  const infoResponse = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/tally/v1/info`, { headers: admin });
  expectEqual(infoResponse.status, 200, 'the info HTTP status');
  const info = await infoResponse.json();
  expectEqual(info.contracts['order.create'].includes(5), true, 'info advertises order.create 5');
  expectEqual(info.maxShippingLines, 1, 'info allows one shipping line');
  expectEqual(info.lineTax, { none: true, classes: true }, 'info honours untaxed lines and tax classes');
  console.log('ok - info advertises order.create 5, one shipping line, untaxed lines and tax classes');
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
    // A store seeded before #56 keeps Denmark, because the seed refuses a seeded database: name the fix.
    if (channel.defaultTaxZone?.name !== 'Germany') {
      throw new Error(`The dev store was seeded with default tax zone ${channel.defaultTaxZone?.name}, ` +
        'not Germany (vendurepos/app#56): run ./reset.sh to reseed it.');
    }
    const rates = taxRates.items.map((rate: { value: number; zone: { name: string }; category: { name: string } }) =>
      `${rate.category.name}/${rate.zone.name}/${rate.value}`);
    // The plugin's bootstrap adds the disabled TALLY-CUSTOM-ITEM variant (ADR 0005).
    if (channel.code !== POS_CHANNEL_CODE || channel.currencyCode !== 'EUR' || channel.pricesIncludeTax !== false ||
        channel.defaultTaxZone?.name !== 'Germany' || productVariants.totalItems !== VARIANT_COUNT + 1 ||
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
