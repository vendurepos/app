import { useState, type JSX } from 'react';
import { Card, CardContent, CardHeader, CardTitle, SettingsRow, Switch, Text, ToggleGroup, ToggleGroupItem, VStack } from '@tallyui/components';
import { loadCartSide, saveCartSide } from './cart-side-setting';
import { cartColumnShown, loadCartColumns, saveCartColumns } from './cart-columns-setting';
import { loadCartSort, saveCartSort } from './cart-sort-setting';

/** Settings › General: v2's Cart settings Panel position (CHECKLIST 9.10). */
export function CartSideSettings(): JSX.Element {
  const [side, setSide] = useState(() => loadCartSide());
  const [columns, setColumns] = useState(() => loadCartColumns());
  const [sort, setSort] = useState(() => loadCartSort());
  const shown = cartColumnShown(columns);
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Cart</CardTitle></CardHeader>
      <CardContent>
        <VStack space="lg">
          <Text>Panel position: which side of the till the cart sits on. On a phone, Products and Cart are tabs, so it has no effect there.</Text>
          <ToggleGroup type="single" accessibilityLabel="Panel position" testID="cart-side" value={side} onValueChange={(value) => {
            if (value !== 'left' && value !== 'right') return;
            saveCartSide(value);
            setSide(value);
          }}>
            {(['left', 'right'] as const).map((item) => (
              <ToggleGroupItem key={item} value={item} testID={`cart-side-${item}`} className={item === side ? 'flex-1 bg-secondary' : 'flex-1'}>
                <Text>{item === 'left' ? 'Cart left' : 'Cart right'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text className="font-semibold">Sort items</Text>
          <ToggleGroup type="single" accessibilityLabel="Sort items" testID="cart-sort" value={sort} onValueChange={(value) => {
            if (value !== 'newest' && value !== 'oldest') return;
            saveCartSort(value);
            setSort(value);
          }}>
            {(['newest', 'oldest'] as const).map((item) => (
              <ToggleGroupItem key={item} value={item} testID={`cart-sort-${item}`} className={item === sort ? 'flex-1 bg-secondary' : 'flex-1'}>
                <Text>{item === 'newest' ? 'Newest at top' : 'Oldest at top'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text>Fees and shipping always stay last.</Text>
          <Text className="font-semibold">Columns</Text>
          <Text>Which columns the cart shows on this device. Price still folds on a narrow cart.</Text>
          <VStack space="none">
            {([
              ['quantity', 'show', 'Qty', shown.quantity, false],
              ['quantity', 'split', 'Split', shown.quantitySplit, !shown.quantity],
              ['image', 'show', 'Image', shown.image, false],
              ['name', 'show', 'Name', shown.name, false],
              ['name', 'sku', 'SKU under the name', shown.nameSku, !shown.name],
              ['sku', 'show', 'SKU', shown.sku, false],
              ['price', 'show', 'Price', shown.price, false],
              ['total', 'show', 'Total', shown.total, false],
            ] as const).map(([column, field, label, checked, disabled]) => (
              <SettingsRow key={`${column}-${field}`} label={label} className={field === 'show' ? undefined : 'pl-6'}
                action={<Switch testID={`cart-column-${column}${field === 'show' ? '' : `-${field}`}`} accessibilityLabel={label}
                  checked={checked} disabled={disabled} onCheckedChange={(on) => {
                    const next = { ...columns, [column]: { ...columns[column], [field]: on } };
                    saveCartColumns(next);
                    setColumns(next);
                  }} />} />
            ))}
          </VStack>
        </VStack>
      </CardContent>
    </Card>
  );
}
