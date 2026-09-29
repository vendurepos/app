import { LanguageCode, mergeConfig } from '@vendure/core';
import { createTestEnvironment, PostgresInitializer, registerInitializer, testConfig } from '@vendure/testing';
import { parse } from 'graphql';
import { TallySpikePlugin } from '../src/plugin/tally-spike.plugin';

export function createS1TestEnvironment(override: Parameters<typeof mergeConfig>[1] = {}) {
  registerInitializer('postgres', new PostgresInitializer());
  const config = mergeConfig(testConfig, {
    dbConnectionOptions: {
      type: 'postgres', host: '127.0.0.1', port: 5444,
      username: 'vendure', password: 'vendure', database: 's1',
    },
    plugins: [TallySpikePlugin],
  });
  const environment = createTestEnvironment(mergeConfig(config, override));
  const { server, adminClient } = environment;
  const variantIds: Record<'mug' | 'beans' | 'print', string[]> = { mug: [], beans: [], print: [] };

  async function init() {
    await server.init({
      customerCount: 0,
      initialData: {
        defaultLanguage: LanguageCode.en,
        defaultZone: 'Denmark',
        countries: [
          { name: 'Denmark', code: 'DK', zone: 'Denmark' },
          { name: 'Germany', code: 'DE', zone: 'Germany' },
        ],
        taxRates: [
          { name: 'Standard', percentage: 25 },
          { name: 'Reduced', percentage: 25 },
        ],
        shippingMethods: [], paymentMethods: [], collections: [],
      },
    });
    await adminClient.asSuperAdmin();
    const setup = await adminClient.query<{
      activeChannel: { id: string };
      taxCategories: { items: Array<{ id: string; name: string }> };
      taxRates: { items: Array<{ id: string; zone: { name: string }; category: { name: string } }> };
    }>(parse(`query {
      activeChannel { id }
      taxCategories { items { id name } }
      taxRates { items { id zone { name } category { name } } }
    }`));
    await adminClient.query(parse(`mutation SetCurrency($id: ID!) {
      updateChannel(input: { id: $id, defaultCurrencyCode: EUR, availableCurrencyCodes: [EUR] }) {
        ... on Channel { id defaultCurrencyCode }
      }
    }`), { id: setup.activeChannel.id });
    for (const rate of setup.taxRates.items.filter(rate => rate.zone.name === 'Germany')) {
      await adminClient.query(parse(`mutation SetRate($id: ID!, $value: Float!) {
        updateTaxRate(input: { id: $id, value: $value }) { id value }
      }`), { id: rate.id, value: rate.category.name === 'Standard' ? 19 : 7 });
    }

    for (const product of [
      { key: 'mug', name: 'Mug', prices: [800], category: 'Standard', stock: 10 },
      { key: 'beans', name: 'Beans', prices: [500, 900], category: 'Reduced', stock: 10 },
      { key: 'print', name: 'Print', prices: [4500], category: 'Standard', stock: 2 },
    ] as const) {
      const { createProduct } = await adminClient.query<{ createProduct: { id: string } }>(parse(`
        mutation CreateProduct($input: CreateProductInput!) { createProduct(input: $input) { id } }
      `), { input: {
        translations: [{ languageCode: 'en', name: product.name, slug: product.key, description: '' }],
      } });
      let options: Array<{ id: string; code: string }> = [];
      if (product.key === 'beans') {
        const { createProductOptionGroup } = await adminClient.query<{
          createProductOptionGroup: { id: string; options: Array<{ id: string; code: string }> };
        }>(parse(`mutation CreateOptions($input: CreateProductOptionGroupInput!) {
          createProductOptionGroup(input: $input) { id options { id code } }
        }`), { input: {
          code: 'beans-variant', translations: [{ languageCode: 'en', name: 'Variant' }],
          options: product.prices.map(price => ({
            code: String(price), translations: [{ languageCode: 'en', name: String(price) }],
          })),
        } });
        options = createProductOptionGroup.options;
        await adminClient.query(parse(`mutation AddOptions($productId: ID!, $optionGroupId: ID!) {
          addOptionGroupToProduct(productId: $productId, optionGroupId: $optionGroupId) { id }
        }`), { productId: createProduct.id, optionGroupId: createProductOptionGroup.id });
      }
      const { createProductVariants } = await adminClient.query<{
        createProductVariants: Array<{ id: string; price: number }>;
      }>(parse(`mutation CreateVariants($input: [CreateProductVariantInput!]!) {
        createProductVariants(input: $input) { id price }
      }`), { input: product.prices.map(price => ({
        productId: createProduct.id,
        sku: `${product.key}-${price}`, price, stockOnHand: product.stock, trackInventory: 'TRUE',
        taxCategoryId: setup.taxCategories.items.find(category => category.name === product.category)!.id,
        translations: [{ languageCode: 'en', name: product.name }],
        optionIds: options.filter(option => option.code === String(price)).map(option => option.id),
      })) });
      variantIds[product.key] = product.prices.map(price => createProductVariants.find(variant => variant.price === price)!.id);
    }
  }

  return { ...environment, init, variantIds };
}
