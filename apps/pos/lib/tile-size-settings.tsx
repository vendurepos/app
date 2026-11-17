import { useState, type JSX } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, SettingsRow, Switch, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { loadShowOutOfStock, saveShowOutOfStock } from './show-out-of-stock-setting';
import { loadTileSize, saveTileSize, TILE_SIZES } from './tile-size-setting';

/** Settings › Products: the tile size and whether out-of-stock products show, for this till. */
export function TileSizeSettings(): JSX.Element {
  const [tileSize, setTileSize] = useState(() => loadTileSize());
  const [showOutOfStock, setShowOutOfStock] = useState(() => loadShowOutOfStock());
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Products</CardTitle></CardHeader>
      <CardContent>
        <VStack space="lg">
          <Text>How many products sit in each row. Auto fits the screen.</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Tile size" testID="tile-size"
            value={String(tileSize)} onValueChange={(value) => {
              if (value === '') return;
              const size = TILE_SIZES.find((size) => String(size) === value)!;
              saveTileSize(size);
              setTileSize(size);
            }}>
            {TILE_SIZES.map((item) => (
              <ToggleGroupItem key={item} value={String(item)} testID={`tile-size-${item}`}
                className={item === tileSize ? 'bg-secondary' : undefined}
                accessibilityLabel={item === 'auto' ? 'Auto' : `${item} a row`}>
                <Text>{item === 'auto' ? 'Auto' : item}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <SettingsRow label="Show out-of-stock products" description="Start the In Stock filter off, so sold-out products show in the grid."
            action={<Switch testID="show-out-of-stock-toggle" accessibilityLabel="Show out-of-stock products" checked={showOutOfStock}
              onCheckedChange={(on) => { saveShowOutOfStock(on); setShowOutOfStock(on); }} />} />
        </VStack>
      </CardContent>
    </Card>
  );
}
