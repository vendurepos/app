import { useState, type JSX } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, CatalogueSettingsForm, SettingsRow, Switch, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { loadShowOutOfStock, saveShowOutOfStock } from './show-out-of-stock-setting';
import { loadTileSize, saveTileSize } from './tile-size-setting';
import { loadTileFields, saveTileFields } from './tile-fields-setting';
import { loadProductSortOption, saveProductSortOption, PRODUCT_SORT_OPTIONS } from './product-sort-setting';
import { loadCategoryBrowse, loadVariationsStyle, saveCategoryBrowse, saveVariationsStyle, CATEGORY_BROWSE_OPTIONS, VARIATIONS_STYLE_OPTIONS } from './catalogue-browse-setting';

/** Settings › Products: the tile size and tile fields (TallyUI's CatalogueSettingsForm), whether out-of-stock products show, the sort, Browse by and Variations, for this till. */
export function TileSizeSettings(): JSX.Element {
  const [tileSize, setTileSize] = useState(() => loadTileSize());
  const [tileFields, setTileFields] = useState(() => loadTileFields());
  const [showOutOfStock, setShowOutOfStock] = useState(() => loadShowOutOfStock());
  const [sortOption, setSortOption] = useState(() => loadProductSortOption());
  const [categoryBrowse, setCategoryBrowse] = useState(() => loadCategoryBrowse());
  const [variationsStyle, setVariationsStyle] = useState(() => loadVariationsStyle());
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Products</CardTitle></CardHeader>
      <CardContent>
        <VStack space="lg">
          <CatalogueSettingsForm gridColumns={tileSize} onGridColumnsChange={(size) => { saveTileSize(size); setTileSize(size); }}
            tileFields={tileFields} onTileFieldsChange={(next) => { saveTileFields(next); setTileFields(next); }} />
          <SettingsRow label="Show out-of-stock products" description="Start the In Stock filter off, so sold-out products show in the grid."
            action={<Switch testID="show-out-of-stock-toggle" accessibilityLabel="Show out-of-stock products" checked={showOutOfStock}
              onCheckedChange={(on) => { saveShowOutOfStock(on); setShowOutOfStock(on); }} />} />
          <Text>Sort products by. A table header in the till sorts until you come back.</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Sort products by" testID="product-sort"
            value={sortOption} onValueChange={(value) => {
              if (value === '') return;
              const found = PRODUCT_SORT_OPTIONS.find((option) => option.value === value)!;
              saveProductSortOption(found.value);
              setSortOption(found.value);
            }}>
            {PRODUCT_SORT_OPTIONS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value} testID={`product-sort-${item.value}`}
                className={item.value === sortOption ? 'bg-secondary' : undefined}
                accessibilityLabel={item.label}>
                <Text>{item.label}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text>Browse by. Category tiles open on the categories, as v2; chips put them in a row above the products.</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Browse by" testID="category-browse-setting"
            value={categoryBrowse} onValueChange={(value) => {
              const found = CATEGORY_BROWSE_OPTIONS.find((option) => option.value === value);
              if (found) { saveCategoryBrowse(found.value); setCategoryBrowse(found.value); }
            }}>
            {CATEGORY_BROWSE_OPTIONS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value} testID={`category-browse-setting-${item.value}`}
                className={item.value === categoryBrowse ? 'bg-secondary' : undefined} accessibilityLabel={item.label}>
                <Text>{item.label}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text>Variations. How a product with variants opens from its tile; the table always lists them.</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Variations" testID="variations-setting"
            value={variationsStyle} onValueChange={(value) => {
              const found = VARIATIONS_STYLE_OPTIONS.find((option) => option.value === value);
              if (found) { saveVariationsStyle(found.value); setVariationsStyle(found.value); }
            }}>
            {VARIATIONS_STYLE_OPTIONS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value} testID={`variations-setting-${item.value}`}
                className={item.value === variationsStyle ? 'bg-secondary' : undefined} accessibilityLabel={item.label}>
                <Text>{item.label}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </VStack>
      </CardContent>
    </Card>
  );
}
