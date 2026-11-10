import { useState, type JSX } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { loadTileSize, saveTileSize, TILE_SIZES } from './tile-size-setting';

/** Settings › Products: the tile size for this till. */
export function TileSizeSettings(): JSX.Element {
  const [tileSize, setTileSize] = useState(() => loadTileSize());
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
            {TILE_SIZES.map((size) => (
              <ToggleGroupItem key={size} value={String(size)} testID={`tile-size-${size}`}
                accessibilityLabel={size === 'auto' ? 'Auto' : `${size} a row`}>
                <Text>{size === 'auto' ? 'Auto' : size}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </VStack>
      </CardContent>
    </Card>
  );
}
