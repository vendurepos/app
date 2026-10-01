import type { CatalogueProduct } from './catalogue';

// Total products, including the fixture mug.
const LARGE_PRODUCT_COUNT = 2_000;
// Fixed mulberry32 seed, reset on every generation.
const RANDOM_SEED = 0x564132;
// Repeating option sizes average 2.8 variants per generated product.
const VARIANT_COUNTS = [1, 2, 2, 3, 6];
// Inclusive minimum price in minor units.
const MIN_PRICE = 99;
// Inclusive maximum price in minor units.
const MAX_PRICE = 49_999;
// Inclusive maximum stock at either location.
const MAX_STOCK = 200;

export function largeCatalogue(): CatalogueProduct[] {
  let state = RANDOM_SEED;
  function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }
  const catalogue: CatalogueProduct[] = [{
    name: 'Tally Fixture Mug', slug: 'tally-fixture-mug', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'TALLY-MUG', priceMinor: 800, warehouseStock: 100, shopFloorStock: 50 }],
  }];
  for (let index = 1; index < LARGE_PRODUCT_COUNT; index++) {
    const number = String(index).padStart(4, '0');
    const count = VARIANT_COUNTS[(index - 1) % VARIANT_COUNTS.length];
    catalogue.push({
      name: `Generated Product ${number}`, slug: `generated-product-${number}`,
      taxCategory: random() < 0.25 ? 'Reduced' : 'Standard',
      trackInventory: random() < 0.9,
      optionGroups: count === 1 ? [] : count === 6 ? ['Size', 'Colour'] : ['Size'],
      variants: Array.from({ length: count }, (_, variant) => ({
        options: count === 1 ? [] : count === 6
          ? [['S', 'M', 'L'][variant % 3], ['Black', 'White'][Math.floor(variant / 3)]]
          : [['S', 'M', 'L'][variant]],
        sku: `GEN-${number}-${variant + 1}`,
        priceMinor: MIN_PRICE + Math.floor(random() * (MAX_PRICE - MIN_PRICE + 1)),
        warehouseStock: Math.floor(random() * (MAX_STOCK + 1)),
        shopFloorStock: Math.floor(random() * (MAX_STOCK + 1)),
      })),
    });
  }
  return catalogue;
}

// Exact variant count, including the fixture mug (5,595).
export const LARGE_TARGET_VARIANTS = largeCatalogue().reduce((count, product) => count + product.variants.length, 0);
