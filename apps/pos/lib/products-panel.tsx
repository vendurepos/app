import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Image, View } from 'react-native';
import { Button, CategoryNav, DEFAULT_PRODUCT_FILTERS, FilterChip, HStack, Input, InputField, ProductFilterBar, ProductTable, SearchInput, Switch, Text, VStack, type ProductTableColumn } from '@tallyui/components';
import { currencySymbol, type ProductTraits } from '@tallyui/core';
import { filterProductRows, productCategories, productRows, STOCK_STATUS_LABELS, type ProductRow, type ProductRowFilters } from './product-rows';
import { refreshCatalogue } from './catalogue';
import { sessionContext, type Session } from './session';
import { PRICE_INVALID_TEXT, STOCK_CHANGED_TEXT, STOCK_INVALID_TEXT, checkStockEdit, saveStock, saveVariantUpdate, useCatalogueEditable, variantUpdateInput, type ProductEdit } from './product-edit';

// Rows shown at a time, as the Customers panel's page.
const PAGE_SIZE = 25;
const FILTER_CHIPS = ['inStock', 'category'] as const;
const ALL_CATEGORIES = 'all';

function EditField({ testID, label, value, prefix, keyboardType, disabled, onSave }: {
  testID: string; label: string; value: string; prefix?: string; keyboardType: 'decimal-pad' | 'number-pad'; disabled?: boolean; onSave(text: string): Promise<boolean>;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  useEffect(() => { setDraft(null); sent.current = null; }, [value]);
  function commit() {
    if (draft === null || draft === value || draft === sent.current) return;
    sent.current = draft;
    void onSave(draft).then(saved => { if (!saved) { sent.current = null; setDraft(null); } });
  }
  return <Input disabled={disabled} className="h-9 w-24">
    {prefix ? <Input.Left><Text className="mr-1 text-sm text-muted-foreground">{prefix}</Text></Input.Left> : null}
    {/* min-w-0: a web <input> has an intrinsic ~20ch width and will not shrink into the 96 px box without it. */}
    <InputField testID={testID} accessibilityLabel={label} value={draft ?? value} onChangeText={setDraft}
      onBlur={commit} onSubmitEditing={commit} keyboardType={keyboardType} className="min-w-0 text-right" />
  </Input>;
}

export function ProductsPanel({ products, traits, currency, session }: { products: any[]; traits: ProductTraits; currency: string; session: Session }): JSX.Element {
  const { editable, priceEditable } = useCatalogueEditable(session, currency);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async (row: ProductRow, edit: ProductEdit): Promise<boolean> => {
    let input = variantUpdateInput(row.id, edit, currency);
    if (input && edit.field === 'stock') {
      const routed = await saveStock(sessionContext(session), row.id, row.stockText, edit.text);
      if (routed !== false) { setError(routed); if (routed === null || routed === STOCK_CHANGED_TEXT) refreshCatalogue(); return routed === null; }
      const checked = await checkStockEdit(sessionContext(session), row.id, edit, row.stockText);
      if (typeof checked === 'string') { setError(checked); if (checked === STOCK_CHANGED_TEXT) refreshCatalogue(); return false; }
      input = checked;
    }
    if (!input) { setError(edit.field === 'price' ? PRICE_INVALID_TEXT : STOCK_INVALID_TEXT); return false; }
    const failure = await saveVariantUpdate(sessionContext(session), input); setError(failure);
    if (failure) return false;
    refreshCatalogue(); return true;
  }, [currency, session]);
  const COLUMNS = useMemo<ProductTableColumn<ProductRow>[]>(() => [
    { id: 'image', header: 'Image', hideHeader: true, flex: 0.6, render: row => row.imageUrl ?
      <Image source={{ uri: row.imageUrl }} testID={`product-image-${row.id}`} accessibilityLabel={row.name}
        resizeMode="cover" className="h-10 w-10 rounded" /> : <View testID={`product-image-${row.id}`} className="h-10 w-10 rounded bg-muted" /> },
    { id: 'name', header: 'Name', flex: 3, render: row => <Text>{row.name}</Text> },
    { id: 'sku', header: 'SKU', render: row => <Text>{row.sku}</Text> },
    { id: 'stock', header: 'Stock', align: 'center', flex: 1, render: row => editable ? <VStack className="items-center gap-1">
      <EditField testID={`product-stock-${row.id}`} label={`Stock of ${row.name}`} value={row.stockText} keyboardType="number-pad"
        disabled={!row.managed || !row.stockTarget}
        onSave={text => row.stockTarget ? save(row, { field: 'stock', text, target: row.stockTarget }) : Promise.resolve(false)} />
      <HStack className="items-center gap-1"><Switch size="sm" testID={`product-manage-${row.id}`} accessibilityLabel={`Manage stock of ${row.name}`}
        checked={row.managed} onCheckedChange={on => { void save(row, { field: 'manage', on }); }} />
        <Text className="text-xs text-muted-foreground">Manage</Text></HStack>
    </VStack> : <Text>{row.stock}</Text> },
    { id: 'stockStatus', header: 'Stock status', flex: 1.2, render: row => <HStack className="items-center gap-2">
      {row.stockStatus !== 'unknown' ? <View className={`h-2 w-2 rounded-full ${row.stockStatus === 'in_stock' ? 'bg-green-600' : row.stockStatus === 'out_of_stock' ? 'bg-destructive' : 'bg-amber-500'}`} /> : null}
      <Text testID={`product-stock-status-${row.id}`}>{STOCK_STATUS_LABELS[row.stockStatus]}</Text>
    </HStack> },
    { id: 'categories', header: 'Categories', flex: 1.5, render: row => <Text numberOfLines={1} testID={`product-categories-${row.id}`}>{row.categories}</Text> },
    { id: 'price', header: 'Price', align: 'right', render: row => priceEditable ?
      <EditField testID={`product-price-${row.id}`} label={`Price of ${row.name}`} prefix={currencySymbol(currency)} value={row.priceText}
        keyboardType="decimal-pad" onSave={text => save(row, { field: 'price', text })} /> : <Text>{row.price}</Text> },
  ], [editable, priceEditable, save, currency]);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  // v2's Products screen lists out-of-stock products, unlike the till, whose In Stock starts on.
  const [filters, setFilters] = useState<ProductRowFilters>({ inStock: false, categoryId: null });
  const [categoryOpen, setCategoryOpen] = useState(false);
  const threshold = session.stock.outOfStockThreshold;
  const rows = useMemo(() => productRows(products, search, traits, currency, threshold), [products, search, traits, currency, threshold]);
  const categories = useMemo(() => productCategories(products, traits), [products, traits]);
  const filtered = useMemo(() => filterProductRows(rows, filters), [rows, filters]);
  const shown = filtered.slice(0, limit);
  return (
    <VStack testID="products-panel" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2">
        <View className="min-w-[200px] flex-1">
          <SearchInput testID="products-search" value={search} onChangeText={value => { setSearch(value); setLimit(PAGE_SIZE); }} placeholder="Name, SKU or barcode" />
        </View>
      </HStack>
      <HStack dataSet={{ print: 'hide' }} className="items-center gap-2 border-b border-border px-4 py-2" testID="products-filters">
        <ProductFilterBar value={{ ...DEFAULT_PRODUCT_FILTERS, inStock: filters.inStock }} chips={FILTER_CHIPS}
          onChange={next => { setFilters(f => ({ ...f, inStock: next.inStock })); setLimit(PAGE_SIZE); }}
          onTermPress={() => setCategoryOpen(open => !open)} />
        {filters.categoryId ? <View testID="products-category-chip">
          <FilterChip label={categories.find(category => category.id === filters.categoryId)?.name ?? 'Category'} active
            onPress={() => { setFilters(f => ({ ...f, categoryId: null })); setLimit(PAGE_SIZE); }} />
        </View> : null}
      </HStack>
      {categoryOpen ? <View testID="products-category-picker" className="border-b border-border px-4 py-2">
        <CategoryNav categories={[{ id: ALL_CATEGORIES, name: 'All categories' }, ...categories]} orientation="horizontal"
          selectedId={filters.categoryId ?? ALL_CATEGORIES}
          onSelect={id => { setFilters(f => ({ ...f, categoryId: id === ALL_CATEGORIES ? null : id })); setLimit(PAGE_SIZE); setCategoryOpen(false); }} />
      </View> : null}
      <ProductTable items={shown} columns={COLUMNS} sortItems={false} showUnsellable emptyState={
        <Text testID="products-empty" className="p-4 text-muted-foreground">
          {search.trim() ? 'No products match this search.' : filters.inStock || filters.categoryId ? 'No products match these filters.' : 'No products on this device yet.'}
        </Text>
      } />
      {error ? <Text testID="products-save-error" className="border-t border-border px-4 py-2 text-sm text-destructive">{error}</Text> : null}
      {filtered.length > 0 ? <HStack className="items-center justify-between border-t border-border px-4 py-3">
        <Text testID="products-count">{`Showing ${shown.length} of ${filtered.length} products`}</Text>
        {shown.length < filtered.length ? <Button testID="products-more" variant="secondary" size="sm" onPress={() => setLimit((n) => n + PAGE_SIZE)}>
          <Text>Show more</Text>
        </Button> : null}
      </HStack> : null}
    </VStack>
  );
}
