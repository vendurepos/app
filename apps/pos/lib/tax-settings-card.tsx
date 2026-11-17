import type { StoreSettings } from '@tallyui/core';
import { Card, CardContent, CardHeader, CardTitle, Text, VStack } from '@tallyui/components';
import { taxRateRows } from './tax-settings';

/** Settings › Tax (CHECKLIST 9.6): read-only, Vendure's way. The channel and its default tax zone decide tax on the server. */
export function TaxSettings({ settings }: { settings: StoreSettings }) {
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Tax</CardTitle></CardHeader>
      <CardContent>
        <VStack space="md">
          <Text testID="tax-prices-include">{`Prices include tax: ${settings.pricesIncludeTax ? 'Yes' : 'No'}`}</Text>
          <Text testID="tax-based-on">{"Tax based on: the channel's default tax zone"}</Text>
          <Text className="text-sm text-muted-foreground">
            Vendure works out tax on the server. Change these in the Vendure admin, under Settings › Channels and Settings › Tax rates.
          </Text>
          {taxRateRows(settings).map(row => (
            <Text key={row.key} testID={`tax-rate-${row.key}`}>{`${row.name} · ${row.rate}`}</Text>
          ))}
        </VStack>
      </CardContent>
    </Card>
  );
}
