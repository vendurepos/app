import { CATALOGUE } from './catalogue';
import { largeCatalogue, LARGE_TARGET_VARIANTS } from './catalogue-large';
import {
  POS_CHANNEL_TOKEN, SERVER_HOST, SERVER_PORT, SUPERADMIN_PASSWORD, SUPERADMIN_USERNAME,
} from './constants';

// Admin endpoint for the selected local store port.
const ADMIN_API = `http://${SERVER_HOST}:${SERVER_PORT}/admin-api`;
// Maximum relative difference allowed by the seed count check.
const COUNT_TOLERANCE = 0.01;

async function check() {
  const catalogue = process.env.VENDURE_SEED === 'large' ? largeCatalogue() : CATALOGUE;
  // The plugin's bootstrap adds the disabled TALLY-CUSTOM-ITEM variant (ADR 0005).
  const expectedVariants = (process.env.VENDURE_SEED === 'large' ? LARGE_TARGET_VARIANTS
    : catalogue.reduce((count, product) => count + product.variants.length, 0)) + 1;
  const login = await fetch(ADMIN_API, {
    method: 'POST', headers: { 'content-type': 'application/json', 'vendure-token': POS_CHANNEL_TOKEN },
    body: JSON.stringify({
      query: `mutation Login($username: String!, $password: String!) {
        login(username: $username, password: $password) {
          ... on CurrentUser { identifier }
          ... on ErrorResult { errorCode message }
        }
      }`,
      variables: { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD },
    }),
  });
  if (!login.ok) throw new Error(`Login HTTP ${login.status}`);
  const loggedIn = await login.json();
  const token = login.headers.get('vendure-auth-token');
  if (loggedIn.errors?.length || loggedIn.data?.login?.identifier !== SUPERADMIN_USERNAME || !token) {
    throw new Error(`Login failed: ${JSON.stringify(loggedIn)}`);
  }
  const response = await fetch(ADMIN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'vendure-token': POS_CHANNEL_TOKEN, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: `{
      products(options: { take: 1 }) { totalItems }
      productVariants(options: { take: 1 }) { totalItems }
      collections(options: { take: 10 }) { totalItems items { name productVariants(options: { take: 1 }) { totalItems } } }
      customers(options: { take: 10 }) { totalItems items { emailAddress } }
    }` }),
  });
  if (!response.ok) throw new Error(`Count query HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  for (const [field, expected] of [['products', catalogue.length], ['productVariants', expectedVariants]] as const) {
    const actual = body.data?.[field]?.totalItems;
    console.log(`${field}: ${actual} (expected ${expected})`);
  }
  if ([[body.data?.products?.totalItems, catalogue.length], [body.data?.productVariants?.totalItems, expectedVariants]]
    .some(([actual, expected]) => typeof actual !== 'number' || Math.abs(actual - expected) > expected * COUNT_TOLERANCE)) {
    throw new Error('POS channel counts differ from the selected seed by more than 1%');
  }
  const collections = body.data.collections;
  if (collections.totalItems !== 5 || ['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts'].some(name =>
    !collections.items.some((collection: { name: string; productVariants: { totalItems: number } }) =>
      collection.name === name && collection.productVariants.totalItems > 0))) {
    throw new Error('Expected five named, non-empty collections in the POS channel');
  }
  const emails = body.data.customers.items.map((customer: { emailAddress: string }) => customer.emailAddress);
  const expectedEmails = ['ada', 'grace', 'alan', 'katherine', 'barbara', 'donald', 'margaret', 'dorothy']
    .map(name => `${name}@demo.vendurepos.com`);
  expectedEmails.push('walk-in@vendurepos.invalid');
  if (body.data.customers.totalItems !== 9 || expectedEmails.some(email => !emails.includes(email))) {
    throw new Error('Expected eight named demo customers and the walk-in customer in the POS channel');
  }
}

check().catch(error => {
  console.error(error);
  process.exit(1);
});
