export function ean13(first12: string): string {
  const sum = [...first12].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return first12 + ((10 - sum % 10) % 10);
}

export interface CatalogueVariant {
  options: string[];
  sku: string;
  priceMinor: number;
  warehouseStock: number;
  shopFloorStock: number;
}

export interface CatalogueProduct {
  name: string;
  slug: string;
  taxCategory: 'Standard' | 'Reduced';
  trackInventory: boolean;
  optionGroups: string[];
  variants: CatalogueVariant[];
}

// Copied from dev/vendure-store/src/catalogue.ts so the demo and dev store have the same goods.
export const CATALOGUE: CatalogueProduct[] = [
  {
    name: 'Tally Fixture Mug', slug: 'tally-fixture-mug', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'TALLY-MUG', priceMinor: 800, warehouseStock: 100, shopFloorStock: 50 }],
  },
  {
    name: 'Espresso Beans', slug: 'espresso-beans', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['250 g'], sku: 'ESP-250', priceMinor: 899, warehouseStock: 100, shopFloorStock: 20 },
      { options: ['1 kg'], sku: 'ESP-1000', priceMinor: 2999, warehouseStock: 50, shopFloorStock: 10 },
    ],
  },
  {
    name: 'Filter Coffee', slug: 'filter-coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'FIL-500', priceMinor: 1299, warehouseStock: 100, shopFloorStock: 20 }],
  },
  {
    name: 'Tally T-Shirt', slug: 'tally-t-shirt', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Size', 'Colour'],
    variants: [
      { options: ['S', 'Black'], sku: 'TEE-S-BLK', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['M', 'Black'], sku: 'TEE-M-BLK', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['L', 'Black'], sku: 'TEE-L-BLK', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['S', 'White'], sku: 'TEE-S-WHT', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['M', 'White'], sku: 'TEE-M-WHT', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['L', 'White'], sku: 'TEE-L-WHT', priceMinor: 1999, warehouseStock: 40, shopFloorStock: 10 },
    ],
  },
  {
    name: 'Tally Hoodie', slug: 'tally-hoodie', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['S'], sku: 'HOOD-S', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['M'], sku: 'HOOD-M', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['L'], sku: 'HOOD-L', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['XL'], sku: 'HOOD-XL', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
    ],
  },
  {
    name: 'Tote Bag', slug: 'tote-bag', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'TOTE', priceMinor: 1499, warehouseStock: 60, shopFloorStock: 15 }],
  },
  {
    name: 'Notebook', slug: 'notebook', taxCategory: 'Standard', trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['A5'], sku: 'NOTE-A5', priceMinor: 699, warehouseStock: 80, shopFloorStock: 20 },
      { options: ['A6'], sku: 'NOTE-A6', priceMinor: 499, warehouseStock: 80, shopFloorStock: 20 },
    ],
  },
  {
    name: 'Postcard Set', slug: 'postcard-set', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'POST-SET', priceMinor: 599, warehouseStock: 80, shopFloorStock: 20 }],
  },
  {
    name: 'Limited Print', slug: 'limited-print', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'PRINT-LTD', priceMinor: 4500, warehouseStock: 2, shopFloorStock: 2 }],
  },
  {
    name: 'Gift Card', slug: 'gift-card', taxCategory: 'Standard', trackInventory: false, optionGroups: ['Amount'],
    variants: [
      { options: ['25 EUR'], sku: 'GIFT-25', priceMinor: 2500, warehouseStock: 0, shopFloorStock: 0 },
      { options: ['50 EUR'], sku: 'GIFT-50', priceMinor: 5000, warehouseStock: 0, shopFloorStock: 0 },
    ],
  },
];

export function barcodeOf(variantIndex: number): string {
  return ean13('200' + String(variantIndex + 1).padStart(9, '0'));
}

// Number of seeded variants, including untracked gift cards.
export const VARIANT_COUNT = CATALOGUE.reduce((count, product) => count + product.variants.length, 0);
// Number of seeded parent products.
export const PRODUCT_COUNT = CATALOGUE.length;
