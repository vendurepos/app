import { useMemo, useState, type JSX } from 'react';
import { View } from 'react-native';
import { Button, HStack, ProductTable, SearchInput, Text, VStack, type ProductTableColumn } from '@tallyui/components';
import type { ProductTraits } from '@tallyui/core';
import { productRows, type ProductRow } from './product-rows';

// Rows shown at a time, as the Customers panel's page.
const PAGE_SIZE = 25;

const COLUMNS: ProductTableColumn<ProductRow>[] = [
  { id: 'name', header: 'Name', flex: 3, render: row => <Text>{row.name}</Text> },
  { id: 'sku', header: 'SKU', render: row => <Text>{row.sku}</Text> },
  { id: 'price', header: 'Price', align: 'right', render: row => <Text>{row.price}</Text> },
  { id: 'stock', header: 'Stock', align: 'center', render: row => <Text>{row.stock}</Text> },
];

export function ProductsPanel({ products, traits, currency }: { products: any[]; traits: ProductTraits; currency: string }): JSX.Element {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const rows = useMemo(() => productRows(products, search, traits, currency), [products, search, traits, currency]);
  const shown = rows.slice(0, limit);
  return (
    <VStack testID="products-panel" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2">
        <View className="min-w-[200px] flex-1">
          <SearchInput testID="products-search" value={search} onChangeText={value => { setSearch(value); setLimit(PAGE_SIZE); }} placeholder="Name, SKU or barcode" />
        </View>
      </HStack>
      <ProductTable items={shown} columns={COLUMNS} sortItems={false} showUnsellable emptyState={
        <Text testID="products-empty" className="p-4 text-muted-foreground">
          {search.trim() ? 'No products match this search.' : 'No products on this device yet.'}
        </Text>
      } />
      {rows.length > 0 ? <HStack className="items-center justify-between border-t border-border px-4 py-3">
        <Text testID="products-count">{`Showing ${shown.length} of ${rows.length} products`}</Text>
        {shown.length < rows.length ? <Button testID="products-more" variant="secondary" size="sm" onPress={() => setLimit((n) => n + PAGE_SIZE)}>
          <Text>Show more</Text>
        </Button> : null}
      </HStack> : null}
    </VStack>
  );
}
