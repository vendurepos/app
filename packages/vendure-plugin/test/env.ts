import { ConfigService, LanguageCode, RequestContextService, mergeConfig } from '@vendure/core';
import type { VendureConfig } from '@vendure/core';
import { createTestEnvironment, PostgresInitializer, registerInitializer, testConfig } from '@vendure/testing';
import { parse } from 'graphql';
import { TallyPosPlugin } from '../src';
import { OrderCreateService } from '../src/service/order-create.service';
import type { CommandEnvelope, OrderCreatePayload } from '../src/vendored/commands';

type Override = Parameters<typeof mergeConfig>[1];
type Plugin = NonNullable<VendureConfig['plugins']>[number];

// docker-compose.yml: project vendurepos-plugin-test on loopback :5445.
export const dbConnectionOptions = {
  type: 'postgres' as const, host: '127.0.0.1', port: 5445,
  username: 'vendure', password: 'vendure', database: 'plugin',
};

export function pluginTestConfig(override: Override = {}, plugins: Plugin[] = [TallyPosPlugin]) {
  registerInitializer('postgres', new PostgresInitializer());
  return mergeConfig(mergeConfig(testConfig, { dbConnectionOptions, plugins }), override);
}

export function createPluginTestEnvironment(override: Override = {}, plugins?: Plugin[]) {
  const environment = createTestEnvironment(pluginTestConfig(override, plugins));
  const { server, adminClient } = environment;
  // Ids as the Admin and Shop APIs give them, which commands carry (review 2), and the decoded ids repositories use.
  const variantIds: Record<'mug' | 'beans' | 'print', string[]> = { mug: [], beans: [], print: [] };
  const serviceIds: Record<'mug' | 'beans' | 'print', string[]> = { mug: [], beans: [], print: [] };

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
      serviceIds[product.key] = variantIds[product.key].map(decode);
    }
  }

  function decode(id: string) {
    return String(server.app.get(ConfigService).entityOptions.entityIdStrategy!.decodeId(id));
  }

  // An entity id as the Admin API gives it, and as commands carry it (TestingEntityIdStrategy: T_1).
  function encode(id: string | number) {
    return String(server.app.get(ConfigService).entityOptions.entityIdStrategy!.encodeId(id));
  }

  // The service is called as VP2's route will call it: a custom-API context in the default channel,
  // or in the channel with the given token.
  async function run(command: CommandEnvelope<OrderCreatePayload>, channelToken?: string) {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'custom', channelOrToken: channelToken });
    return server.app.get(OrderCreateService).create(ctx, command);
  }

  return { ...environment, init, variantIds, serviceIds, decode, encode, run };
}
