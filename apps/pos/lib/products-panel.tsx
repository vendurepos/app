import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { Button, CategoryNav, DEFAULT_PRODUCT_FILTERS, FilterChip, HStack, IconButton, Input, InputField, ProductFilterBar, ProductTable, SearchInput, Switch, Text, VStack, type ProductTableColumn } from '@tallyui/components';
import { currencySymbol, type ProductTraits } from '@tallyui/core';
import { type ProductSort } from '@tallyui/pos';
import { filterProductRows, groupProductRows, productCategories, productRows, productRowSortValue, sortProductRows, STOCK_STATUS_LABELS, type PanelRow, type ProductRow, type ProductRowFilters } from './product-rows';
import { productFacets, usePublicFacetIds } from './product-facets';
import { refreshCatalogue } from './catalogue';
import { RefreshIcon } from './nav-icons';
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
  // The products whose "N variations" group is open (10.2j): kept across search, filters and sort, empty when the panel opens.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((productId: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(productId)) next.add(productId);
    return next;
  }), []);
  const COLUMNS = useMemo<ProductTableColumn<PanelRow>[]>(() => [
    { id: 'image', header: 'Image', hideHeader: true, flex: 0.6, render: row => row.imageUrl ?
      <Image source={{ uri: row.imageUrl }} testID={`product-image-${row.id}`} accessibilityLabel={row.name}
        resizeMode="cover" className="h-10 w-10 rounded" /> : <View testID={`product-image-${row.id}`} className="h-10 w-10 rounded bg-muted" /> },
    { id: 'name', header: 'Name', flex: 2.5, sortValue: row => productRowSortValue(row, 'name'), render: row => row.group ? <VStack className="items-start gap-0.5">
      <Text>{row.name}</Text>
      <Pressable testID={`product-variations-${row.group.productId}`} accessibilityRole="button" aria-expanded={row.group.open}
        accessibilityLabel={`Show variations of ${row.name}`} onPress={() => toggle(row.group!.productId)}>
        <Text className="text-sm text-primary">{`${row.group.count} variations ${row.group.open ? '⌄' : '›'}`}</Text>
      </Pressable>
    </VStack> : <Text className={row.childOf ? 'pl-6' : undefined}>{row.name}</Text> },
    { id: 'sku', header: 'SKU', sortValue: row => productRowSortValue(row, 'sku'), render: row => <Text>{row.sku}</Text> },
    { id: 'stock', header: 'Stock', align: 'center', flex: 1, sortValue: row => productRowSortValue(row, 'stock'), render: row => editable && !row.group ? <VStack className="items-center gap-1">
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
    // Price 1.5, taken from Name: at 960 px a group's range ("€8.99 – €29.99") stays on one line (CHECKLIST 10.2l; v2's 08 wraps it, one line is our call).
    { id: 'price', header: 'Price', align: 'right', flex: 1.5, sortValue: row => productRowSortValue(row, 'price'), render: row => priceEditable && !row.group ?
      <EditField testID={`product-price-${row.id}`} label={`Price of ${row.name}`} prefix={currencySymbol(currency)} value={row.priceText}
        keyboardType="decimal-pad" onSave={text => save(row, { field: 'price', text })} /> : <Text testID={row.group ? `product-price-range-${row.group.productId}` : undefined}>{row.price}</Text> },
  ], [editable, priceEditable, save, currency, toggle]);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [sort, setSort] = useState<ProductSort | null>(null);
  // v2's Products screen lists out-of-stock products, unlike the till, whose In Stock starts on.
  const [filters, setFilters] = useState<ProductRowFilters>({ inStock: false, categoryId: null, facets: {} });
  const [categoryOpen, setCategoryOpen] = useState(false);
  const threshold = session.stock.outOfStockThreshold;
  const rows = useMemo(() => productRows(products, search, traits, currency, threshold), [products, search, traits, currency, threshold]);
  const categories = useMemo(() => productCategories(products, traits), [products, traits]);
  const shownFacets = usePublicFacetIds(session);
  const facets = useMemo(() => productFacets(products, shownFacets), [products, shownFacets]);
  const [facetOpen, setFacetOpen] = useState<string | null>(null);
  const openFacet = facets.find(facet => facet.id === facetOpen);
  const filtered = useMemo(() => filterProductRows(rows, filters), [rows, filters]);
  const sorted = useMemo(() => sortProductRows(filtered, sort), [filtered, sort]);
  const { shown, shownTop, totalTop } = useMemo(() => groupProductRows(sorted, open, limit), [sorted, open, limit]);
  return (
    <VStack testID="products-panel" className="flex-1">
      <HStack dataSet={{ print: 'hide' }} className="items-center border-b border-border px-4 py-2">
        <View className="min-w-[200px] flex-1">
          <SearchInput testID="products-search" value={search} onChangeText={value => { setSearch(value); setLimit(PAGE_SIZE); }} placeholder="Name, SKU or barcode" />
        </View>
      </HStack>
      <HStack dataSet={{ print: 'hide' }} className="items-center gap-2 border-b border-border px-4 py-2" testID="products-filters">
        {/* !grow-0: TallyUI's bar is a growing ScrollView, and RN-web's own flexGrow class outranks a plain grow-0; without it the facet pills start mid-row. */}
        <ProductFilterBar className="!grow-0" value={{ ...DEFAULT_PRODUCT_FILTERS, inStock: filters.inStock }} chips={FILTER_CHIPS}
          onChange={next => { setFilters(f => ({ ...f, inStock: next.inStock })); setLimit(PAGE_SIZE); }}
          onTermPress={() => { setFacetOpen(null); setCategoryOpen(open => !open); }} />
        {filters.categoryId ? <View testID="products-category-chip">
          <FilterChip label={categories.find(category => category.id === filters.categoryId)?.name ?? 'Category'} active
            onPress={() => { setFilters(f => ({ ...f, categoryId: null })); setLimit(PAGE_SIZE); }} />
        </View> : null}
        {/* Many facets scroll sideways; the row never wraps the panel taller (Front desk ruling, 2026-11-21). */}
        {facets.length ? <ScrollView horizontal testID="products-facet-pills" className="flex-1" contentContainerClassName="items-center gap-2"
          showsHorizontalScrollIndicator={false}>
          {facets.map(facet => {
            const value = facet.values.find(v => v.id === filters.facets?.[facet.id]);
            return <View key={facet.id} testID={`products-facet-${facet.id}`}>
              {value ? <FilterChip label={`${facet.name}: ${value.name}`} active onPress={() => {
                setFilters(f => ({ ...f, facets: Object.fromEntries(Object.entries(f.facets ?? {}).filter(([id]) => id !== facet.id)) }));
                setLimit(PAGE_SIZE);
              }} /> :
                // The look of ProductFilterBar's Category chip, as v2's Tags and Brands pills (TallyUI exports no single chip).
                <Pressable role="button" aria-pressed={false}
                  onPress={() => { setCategoryOpen(false); setFacetOpen(open => open === facet.id ? null : facet.id); }}
                  className="min-h-11 flex-row items-center rounded-full border border-border bg-card px-3">
                  <Text className="text-sm text-foreground">{facet.name}</Text>
                </Pressable>}
            </View>;
          })}
        </ScrollView> : null}
      </HStack>
      {categoryOpen ? <View testID="products-category-picker" className="border-b border-border px-4 py-2">
        <CategoryNav categories={[{ id: ALL_CATEGORIES, name: 'All categories' }, ...categories]} orientation="horizontal"
          selectedId={filters.categoryId ?? ALL_CATEGORIES}
          onSelect={id => { setFilters(f => ({ ...f, categoryId: id === ALL_CATEGORIES ? null : id })); setLimit(PAGE_SIZE); setCategoryOpen(false); }} />
      </View> : null}
      {openFacet ? <View testID={`products-facet-picker-${openFacet.id}`} className="border-b border-border px-4 py-2">
        <CategoryNav categories={openFacet.values} orientation="horizontal" selectedId=""
          onSelect={id => { setFilters(f => ({ ...f, facets: { ...f.facets, [openFacet.id]: id } })); setLimit(PAGE_SIZE); setFacetOpen(null); }} />
      </View> : null}
      <ProductTable items={shown} columns={COLUMNS} sort={sort} onSortChange={next => { setSort(next); setLimit(PAGE_SIZE); }} sortItems={false} showUnsellable emptyState={
        <Text testID="products-empty" className="p-4 text-muted-foreground">
          {search.trim() ? 'No products match this search.' : filters.inStock || filters.categoryId || Object.keys(filters.facets ?? {}).length ? 'No products match these filters.' : 'No products on this device yet.'}
        </Text>
      } />
      {error ? <Text testID="products-save-error" className="border-t border-border px-4 py-2 text-sm text-destructive">{error}</Text> : null}
      {filtered.length > 0 ? <HStack className="items-center justify-between border-t border-border px-4 py-3">
        <HStack className="items-center gap-1">
          <Text testID="products-count">{`Showing ${shownTop} of ${totalTop} products`}</Text>
          <IconButton testID="products-refresh" variant="ghost" size="sm" accessibilityLabel="Refresh products" onPress={() => { refreshCatalogue(); }}>
            <RefreshIcon size={16} />
          </IconButton>
        </HStack>
        {shownTop < totalTop ? <Button testID="products-more" variant="secondary" size="sm" onPress={() => setLimit((n) => n + PAGE_SIZE)}>
          <Text>Show more</Text>
        </Button> : null}
      </HStack> : null}
    </VStack>
  );
}
