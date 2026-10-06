import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapWorker, Channel, ChannelService, CollectionService, ConfigService, CurrencyCode, CustomerService,
  FacetValueService, isGraphQlErrorResult, JobQueueService, LanguageCode, SqlJobQueueStrategy, SubscribableJob,
  ProductService, ProductVariant, ProductVariantService, RequestContextService, SearchService,
  StockLocationService, TaxCategoryService, TaxRateService, TransactionalConnection, User, ZoneService,
} from '@vendure/core';
import { importProductsFromCsv, populateInitialData } from '@vendure/core/cli';
import { SortOrder } from '@vendure/common/lib/generated-types';
import { In } from 'typeorm';
import { CATALOGUE, barcodeOf } from './catalogue';
import { largeCatalogue } from './catalogue-large';
import { DEFAULT_CHANNEL_TOKEN, POS_CHANNEL_CODE, POS_CHANNEL_TOKEN, SUPERADMIN_USERNAME } from './constants';
import { config } from './vendure-config';

// Keep the curated catalogue unless the large seed is explicitly selected.
const catalogue = process.env.VENDURE_SEED === 'large' ? largeCatalogue() : CATALOGUE;
// Expected CSV import count for the selected catalogue.
const PRODUCT_COUNT = catalogue.length;
// Expected variant count for the selected catalogue.
const VARIANT_COUNT = catalogue.reduce((count, product) => count + product.variants.length, 0);
// Bound SKU lookup queries while preserving the per-variant stock updates.
const VARIANT_BATCH_SIZE = 200;

async function seed() {
  const { app } = await bootstrapWorker({
    ...config, dbConnectionOptions: { ...config.dbConnectionOptions, synchronize: true },
  });
  const connection = app.get(TransactionalConnection);
  if (await connection.rawConnection.getRepository(Channel).findOneBy({ code: POS_CHANNEL_CODE })) {
    throw new Error('database already seeded; run ./reset.sh');
  }
  async function adminCtx(channelOrToken?: string) {
    const user = await connection.rawConnection.getRepository(User).findOneOrFail({
      where: { identifier: SUPERADMIN_USERNAME }, relations: ['roles', 'roles.channels'],
    });
    return app.get(RequestContextService).create({ apiType: 'admin', user, channelOrToken });
  }
  let ctx = await adminCtx();
  const channels = app.get(ChannelService);
  let defaultChannel = await channels.getDefaultChannel(ctx);
  const updated = await channels.update(ctx, {
    id: defaultChannel.id, defaultCurrencyCode: CurrencyCode.EUR,
    availableCurrencyCodes: [CurrencyCode.EUR], pricesIncludeTax: false,
  });
  if (isGraphQlErrorResult(updated)) throw new Error(updated.message);
  await populateInitialData(app, {
    defaultLanguage: LanguageCode.en, defaultZone: 'Germany',
    countries: [
      { code: 'DK', name: 'Denmark', zone: 'Denmark' },
      { code: 'DE', name: 'Germany', zone: 'Germany' },
    ],
    taxRates: [], shippingMethods: [], paymentMethods: [], collections: [],
  });
  const { items: zones } = await app.get(ZoneService).findAll(ctx, { take: 100 });
  const denmark = zones.find(zone => zone.name === 'Denmark');
  const germany = zones.find(zone => zone.name === 'Germany');
  defaultChannel = await channels.getDefaultChannel(ctx);
  if (!denmark || !germany || defaultChannel.defaultTaxZone?.id !== germany.id) {
    throw new Error('Initial data did not set Germany as the default tax zone or create both zones');
  }
  const categories = app.get(TaxCategoryService);
  const standard = await categories.create(ctx, { name: 'Standard', isDefault: true });
  const reduced = await categories.create(ctx, { name: 'Reduced' });
  // The default zone is Germany (Standard 19 %, Reduced 7 %), so the two categories are different
  // rate groups. The Danish rates stay as they are: Denmark has no reduced VAT rate.
  for (const [category, zone, name, value] of [
    [standard, denmark, 'Standard DK', 25], [standard, germany, 'Standard DE', 19],
    [reduced, denmark, 'Reduced DK', 25], [reduced, germany, 'Reduced DE', 7],
  ] as const) {
    await app.get(TaxRateService).create(ctx, {
      name, value, enabled: true, categoryId: category.id, zoneId: zone.id,
    });
  }
  const locations = app.get(StockLocationService);
  const warehouse = await locations.defaultStockLocation(ctx);
  await locations.update(ctx, { id: warehouse.id, name: 'Warehouse' });

  const rows: string[][] = [[
    'name', 'slug', 'description', 'assets', 'facets', 'optionGroups', 'optionValues', 'sku',
    'price', 'taxCategory', 'stockOnHand', 'trackInventory', 'variantAssets', 'variantFacets', 'variant:barcode',
  ]];
  let variantIndex = 0;
  for (const product of catalogue) {
    product.variants.forEach((variant, i) => rows.push([
      i === 0 ? product.name : '', i === 0 ? product.slug : '',
      i === 0 ? `${product.name} (VendurePOS dev seed)` : '', '', i === 0 ? `category:${product.category}` : '',
      i === 0 ? product.optionGroups.join('|') : '', variant.options.join('|'), variant.sku,
      (variant.priceMinor / 100).toFixed(2), product.taxCategory, String(variant.warehouseStock),
      String(product.trackInventory), '', '', barcodeOf(variantIndex++),
    ]));
  }
  const directory = mkdtempSync(join(tmpdir(), 'vendurepos-seed-'));
  try {
    const csvPath = join(directory, 'catalogue.csv');
    writeFileSync(csvPath, rows.map(row => row.map(field => `"${field.replace(/"/g, '""')}"`).join(',')).join('\n'));
    const result = await importProductsFromCsv(app, csvPath, LanguageCode.en);
    const errors = result.errors ?? [];
    if (errors.length > 0 || result.imported !== PRODUCT_COUNT) {
      throw new Error(`Imported ${result.imported}/${PRODUCT_COUNT} products: ${errors.join('\n')}`);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
  const posChannel = await channels.create(ctx, {
    code: POS_CHANNEL_CODE, token: POS_CHANNEL_TOKEN, defaultLanguageCode: LanguageCode.en,
    defaultCurrencyCode: CurrencyCode.EUR, availableCurrencyCodes: [CurrencyCode.EUR], pricesIncludeTax: false,
    defaultTaxZoneId: germany.id, defaultShippingZoneId: germany.id, sellerId: defaultChannel.sellerId,
  });
  if (isGraphQlErrorResult(posChannel)) throw new Error(posChannel.message);
  // Reload the superadmin's roles after channel creation, before any channel assignment.
  ctx = await adminCtx();
  const posCtx = await adminCtx(POS_CHANNEL_TOKEN);
  const products = app.get(ProductService);
  for (let skip = 0; skip < PRODUCT_COUNT; skip += 100) {
    const { items } = await products.findAll(ctx, { skip, take: 100 });
    await products.assignProductsToChannel(ctx, {
      productIds: items.map(product => product.id), channelId: posChannel.id, priceFactor: 1,
    });
  }
  const collections = app.get(CollectionService);
  const facetValues = await app.get(FacetValueService).findAll(ctx, LanguageCode.en);
  for (const name of ['Coffee', 'Drinkware', 'Apparel', 'Stationery', 'Gifts']) {
    const facetValue = facetValues.find(value => value.facet.code === 'category' && value.name === name)!;
    const collection = await collections.create(ctx, {
      translations: [{ languageCode: LanguageCode.en, name, slug: name.toLowerCase(), description: '' }],
      filters: [{ code: 'facet-value-filter', arguments: [
        { name: 'facetValueIds', value: JSON.stringify([facetValue.id]) },
        { name: 'containsAny', value: 'true' },
      ] }],
    });
    await collections.assignCollectionsToChannel(ctx, { collectionIds: [collection.id], channelId: posChannel.id });
  }
  for (const [firstName, lastName, email] of [
    ['Ada', 'Lovelace', 'ada'], ['Grace', 'Hopper', 'grace'], ['Alan', 'Turing', 'alan'],
    ['Katherine', 'Johnson', 'katherine'], ['Barbara', 'Liskov', 'barbara'], ['Donald', 'Knuth', 'donald'],
    ['Margaret', 'Mead', 'margaret'], ['Dorothy', 'Vaughan', 'dorothy'],
  ]) {
    const customer = await app.get(CustomerService).create(posCtx, {
      firstName, lastName, emailAddress: `${email}@demo.vendurepos.com`,
    });
    if (isGraphQlErrorResult(customer)) throw new Error(customer.message);
  }
  const shopFloor = await locations.create(posCtx, {
    name: 'Shop floor', description: 'POS stock, VendurePOS dev seed',
  });
  if (!shopFloor.channels.some(channel => channel.id === posChannel.id)) {
    await locations.assignStockLocationsToChannel(posCtx, {
      stockLocationIds: [shopFloor.id], channelId: posChannel.id,
    });
  }
  const tracked = catalogue.filter(product => product.trackInventory).flatMap(product => product.variants);
  for (let offset = 0; offset < tracked.length; offset += VARIANT_BATCH_SIZE) {
    const batch = tracked.slice(offset, offset + VARIANT_BATCH_SIZE);
    const entities = await connection.rawConnection.getRepository(ProductVariant).findBy({
      sku: In(batch.map(variant => variant.sku)),
    });
    const bySku = new Map(entities.map(entity => [entity.sku, entity]));
    for (const variant of batch) {
      const entity = bySku.get(variant.sku)!;
      await app.get(ProductVariantService).update(posCtx, [{
        id: entity.id, stockLevels: [{ stockLocationId: shopFloor.id, stockOnHand: variant.shopFloorStock }],
      }]);
    }
  }
  // Historic orders are not seeded here because the plugin settles payments only through its POS route;
  // the smoke's own sales create orders.
  await collections.triggerApplyFiltersJob(ctx, { applyToChangedVariantsOnly: false });
  const jobStrategy = app.get(ConfigService).jobQueueOptions.jobQueueStrategy as SqlJobQueueStrategy;
  const { items: [filtersJob] } = await jobStrategy.findMany({
    filter: { queueName: { eq: 'apply-collection-filters' } }, sort: { createdAt: SortOrder.DESC }, take: 1,
  });
  await app.get(JobQueueService).start();
  await new SubscribableJob(filtersJob, jobStrategy).updates().toPromise();
  await app.get(SearchService).reindex(ctx);
  await app.get(SearchService).reindex(posCtx);
  console.log(`Channels: ${defaultChannel.code} (${DEFAULT_CHANNEL_TOKEN}), ${posChannel.code} (${POS_CHANNEL_TOKEN})`);
  console.log(`Seeded ${PRODUCT_COUNT} products, ${VARIANT_COUNT} variants; superadmin: ${SUPERADMIN_USERNAME}`);
  await app.close();
  process.exit(0);
}

seed().catch(error => {
  console.error(error);
  process.exit(1);
});
