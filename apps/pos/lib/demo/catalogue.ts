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
  category: 'Coffee' | 'Drinkware' | 'Apparel' | 'Stationery' | 'Gifts';
  trackInventory: boolean;
  optionGroups: string[];
  variants: CatalogueVariant[];
}

// Copied from dev/vendure-store/src/catalogue.ts so the demo and dev store have the same goods.
export const CATALOGUE: CatalogueProduct[] = [
  {
    name: 'Tally Fixture Mug', slug: 'tally-fixture-mug', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'TALLY-MUG', priceMinor: 800, warehouseStock: 100, shopFloorStock: 50 }],
  },
  {
    name: 'Espresso Beans', slug: 'espresso-beans', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['250 g'], sku: 'ESP-250', priceMinor: 899, warehouseStock: 100, shopFloorStock: 20 },
      { options: ['1 kg'], sku: 'ESP-1000', priceMinor: 2999, warehouseStock: 50, shopFloorStock: 10 },
    ],
  },
  {
    name: 'Filter Coffee', slug: 'filter-coffee', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'FIL-500', priceMinor: 1299, warehouseStock: 100, shopFloorStock: 20 }],
  },
  {
    name: 'Tally T-Shirt', slug: 'tally-t-shirt', category: 'Apparel', taxCategory: 'Standard',
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
    name: 'Tally Hoodie', slug: 'tally-hoodie', category: 'Apparel', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['S'], sku: 'HOOD-S', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['M'], sku: 'HOOD-M', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['L'], sku: 'HOOD-L', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
      { options: ['XL'], sku: 'HOOD-XL', priceMinor: 4999, warehouseStock: 20, shopFloorStock: 5 },
    ],
  },
  {
    name: 'Tote Bag', slug: 'tote-bag', category: 'Gifts', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'TOTE', priceMinor: 1499, warehouseStock: 60, shopFloorStock: 15 }],
  },
  {
    name: 'Notebook', slug: 'notebook', category: 'Stationery', taxCategory: 'Standard', trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['A5'], sku: 'NOTE-A5', priceMinor: 699, warehouseStock: 80, shopFloorStock: 20 },
      { options: ['A6'], sku: 'NOTE-A6', priceMinor: 499, warehouseStock: 80, shopFloorStock: 20 },
    ],
  },
  {
    name: 'Postcard Set', slug: 'postcard-set', category: 'Stationery', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'POST-SET', priceMinor: 599, warehouseStock: 80, shopFloorStock: 20 }],
  },
  {
    name: 'Limited Print', slug: 'limited-print', category: 'Gifts', taxCategory: 'Standard', trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'PRINT-LTD', priceMinor: 4500, warehouseStock: 2, shopFloorStock: 2 }],
  },
  {
    name: 'Gift Card', slug: 'gift-card', category: 'Gifts', taxCategory: 'Standard', trackInventory: false, optionGroups: ['Amount'],
    variants: [
      { options: ['25 EUR'], sku: 'GIFT-25', priceMinor: 2500, warehouseStock: 0, shopFloorStock: 0 },
      { options: ['50 EUR'], sku: 'GIFT-50', priceMinor: 5000, warehouseStock: 0, shopFloorStock: 0 },
    ],
  },
  { name: 'Decaf Coffee', slug: 'decaf-coffee', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['250 g'], sku: 'COF-DECAF-250', priceMinor: 1099, warehouseStock: 80, shopFloorStock: 20 },
      { options: ['1 kg'], sku: 'COF-DECAF-1000', priceMinor: 3699, warehouseStock: 40, shopFloorStock: 10 },
    ],
  },
  { name: 'House Blend', slug: 'house-blend', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'COF-HOUSE-250', priceMinor: 999, warehouseStock: 100, shopFloorStock: 20 }],
  },
  { name: 'Cold Brew', slug: 'cold-brew', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'COF-COLD-250', priceMinor: 450, warehouseStock: 60, shopFloorStock: 15 }],
  },
  { name: 'Chocolate Biscuits', slug: 'chocolate-biscuits', category: 'Coffee', taxCategory: 'Reduced',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'COF-BISCUITS', priceMinor: 650, warehouseStock: 80, shopFloorStock: 20 }],
  },
  { name: 'Enamel Cup', slug: 'enamel-cup', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Colour'],
    variants: [
      { options: ['Blue'], sku: 'DRK-ENAMEL-BLU', priceMinor: 1299, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['Cream'], sku: 'DRK-ENAMEL-CRM', priceMinor: 1299, warehouseStock: 40, shopFloorStock: 10 },
    ],
  },
  { name: 'Travel Tumbler', slug: 'travel-tumbler', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'DRK-TUMBLER', priceMinor: 2499, warehouseStock: 40, shopFloorStock: 10 }],
  },
  { name: 'Espresso Cup', slug: 'espresso-cup', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'DRK-ESPRESSO', priceMinor: 699, warehouseStock: 80, shopFloorStock: 20 }],
  },
  { name: 'Glass Carafe', slug: 'glass-carafe', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'DRK-CARAFE', priceMinor: 2299, warehouseStock: 20, shopFloorStock: 0 }],
  },
  { name: 'Water Bottle', slug: 'water-bottle', category: 'Drinkware', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'DRK-BOTTLE', priceMinor: 1999, warehouseStock: 60, shopFloorStock: 15 }],
  },
  { name: 'Cotton Beanie', slug: 'cotton-beanie', category: 'Apparel', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Colour'],
    variants: [
      { options: ['Navy'], sku: 'APP-BEANIE-NVY', priceMinor: 1799, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['Grey'], sku: 'APP-BEANIE-GRY', priceMinor: 1799, warehouseStock: 40, shopFloorStock: 10 },
    ],
  },
  { name: 'Canvas Apron', slug: 'canvas-apron', category: 'Apparel', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'APP-APRON', priceMinor: 3499, warehouseStock: 20, shopFloorStock: 5 }],
  },
  { name: 'Cotton Socks', slug: 'cotton-socks', category: 'Apparel', taxCategory: 'Standard',
    trackInventory: true, optionGroups: ['Size'],
    variants: [
      { options: ['S'], sku: 'APP-SOCKS-S', priceMinor: 999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['M'], sku: 'APP-SOCKS-M', priceMinor: 999, warehouseStock: 40, shopFloorStock: 10 },
      { options: ['L'], sku: 'APP-SOCKS-L', priceMinor: 999, warehouseStock: 40, shopFloorStock: 10 },
    ],
  },
  { name: 'Tally Cap', slug: 'tally-cap', category: 'Apparel', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'APP-CAP', priceMinor: 2199, warehouseStock: 40, shopFloorStock: 10 }],
  },
  { name: 'Pencil Set', slug: 'pencil-set', category: 'Stationery', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'STA-PENCILS', priceMinor: 499, warehouseStock: 80, shopFloorStock: 20 }],
  },
  { name: 'Rollerball Pen', slug: 'rollerball-pen', category: 'Stationery', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'STA-PEN', priceMinor: 399, warehouseStock: 80, shopFloorStock: 20 }],
  },
  { name: 'Weekly Planner', slug: 'weekly-planner', category: 'Stationery', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'STA-PLANNER', priceMinor: 1299, warehouseStock: 40, shopFloorStock: 0 }],
  },
  { name: 'Washi Tape Set', slug: 'washi-tape-set', category: 'Stationery', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'STA-TAPE', priceMinor: 799, warehouseStock: 60, shopFloorStock: 15 }],
  },
  { name: 'Leather Keyring', slug: 'leather-keyring', category: 'Gifts', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'GFT-KEYRING', priceMinor: 899, warehouseStock: 60, shopFloorStock: 15 }],
  },
  { name: 'Cork Coaster Set', slug: 'cork-coaster-set', category: 'Gifts', taxCategory: 'Standard',
    trackInventory: true, optionGroups: [],
    variants: [{ options: [], sku: 'GFT-COASTERS', priceMinor: 1199, warehouseStock: 40, shopFloorStock: 10 }],
  },
  { name: 'Gift Wrapping', slug: 'gift-wrapping', category: 'Gifts', taxCategory: 'Standard',
    trackInventory: false, optionGroups: [],
    variants: [{ options: [], sku: 'GFT-WRAPPING', priceMinor: 300, warehouseStock: 0, shopFloorStock: 0 }],
  },
];

export function barcodeOf(variantIndex: number): string {
  return ean13('200' + String(variantIndex + 1).padStart(9, '0'));
}

// Number of seeded variants, including untracked gift cards.
export const VARIANT_COUNT = CATALOGUE.reduce((count, product) => count + product.variants.length, 0);
// Number of seeded parent products.
export const PRODUCT_COUNT = CATALOGUE.length;
