import { useState, type JSX } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Text, ToggleGroup, ToggleGroupItem, VStack } from '@tallyui/components';
import { loadCartSide, saveCartSide } from './cart-side-setting';

/** Settings › General: v2's Cart settings Panel position (CHECKLIST 9.10). */
export function CartSideSettings(): JSX.Element {
  const [side, setSide] = useState(() => loadCartSide());
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
        </VStack>
      </CardContent>
    </Card>
  );
}
