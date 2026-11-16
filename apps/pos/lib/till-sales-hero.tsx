import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Card, type SalesFilters } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import type { SalesFigures } from '@tallyui/pos';
import { compareLabel, isOneDay } from './till-reports';

const signed = (diff: number, format: (n: number) => string) =>
  diff === 0 ? '±0' : `${diff > 0 ? '+' : '−'}${format(Math.abs(diff))}`;

export function TillSalesHero({ figures, filters, onFiltersChange, currency, hourly }: {
  figures: SalesFigures; filters: SalesFilters; onFiltersChange(next: SalesFilters): void; currency: string;
  hourly: { hours: number[]; compareHours: number[] } | null;
}) {
  const wide = useWindowDimensions().width >= 640;
  const money = (minor: number) => formatMoney({ amount: minor, currency }) ?? '';
  const { totals, series } = figures;
  const before = figures.comparison && figures.comparison.totals.orderCount > 0 ? figures.comparison.totals : undefined;
  const label = compareLabel(filters);
  const grossDiff = before ? totals.grossMinor - before.grossMinor : 0;
  const pct = before && before.grossMinor !== 0 ? Math.round((grossDiff / before.grossMinor) * 1000) / 10 : undefined;
  const companions = [
    { id: 'orders', name: 'Orders', value: totals.orderCount, prev: before?.orderCount, format: String },
    { id: 'average', name: 'Average order', value: totals.averageMinor, prev: before?.averageMinor, format: money },
    { id: 'items', name: 'Items', value: totals.items, prev: before?.items, format: String },
  ];
  const values = hourly ? hourly.hours : series.map((point) => point.grossMinor);
  const compareValues = hourly ? hourly.compareHours : (figures.comparison?.series ?? []).map((point) => point.grossMinor);
  const max = Math.max(0, ...values, ...compareValues);
  const height = (gross: number) => `${max > 0 ? (Math.max(0, gross) / max) * 100 : 0}%` as const;
  const mode = hourly ? 'hour' : 'day';
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <Card testID="sales-hero" className="gap-4 p-4">
      <View className={wide ? 'flex-row items-start gap-8' : 'gap-4'}>
        <View className="gap-0.5">
          <Text testID="hero-total" className="text-4xl font-bold text-foreground">{money(totals.grossMinor)}</Text>
          {pct !== undefined && <Text testID="hero-delta" className={`text-sm ${pct === 0 ? 'text-muted-foreground' : pct > 0 ? 'text-success' : 'text-destructive'}`}>
            {pct === 0 ? '±0%' : signed(pct, (n) => `${n.toFixed(1)}%`)} {label}
          </Text>}
        </View>
        <View className="flex-row flex-wrap gap-6">
          {companions.map(({ id, name, value, prev, format }) => (
            <View key={id} className="gap-0.5">
              <Text className="text-xs text-muted-foreground">{name}</Text>
              <Text testID={`hero-${id}`} className="text-lg font-semibold text-foreground">{format(value)}</Text>
              {prev !== undefined && <Text testID={`hero-${id}-delta`} className={`text-sm ${value === prev ? 'text-muted-foreground' : value > prev ? 'text-success' : 'text-destructive'}`}>
                {signed(value - prev, format)}
              </Text>}
            </View>
          ))}
        </View>
      </View>
      <Pressable testID="hero-compare" accessibilityRole="button" disabled={!isOneDay(filters)}
        onPress={() => onFiltersChange({ ...filters, compare: filters.compare === 'previous' ? 'week' : 'previous' })}
        className="self-start rounded-md border border-border px-3 py-1">
        <Text className="text-sm text-muted-foreground">⇄ {label}</Text>
      </Pressable>
      <View testID="hero-chart" className="w-full">
        <View className="h-40 flex-row items-end border-b border-border">
          {values.map((gross, i) => (
            <View key={i} className="flex-1 h-full flex-row items-end justify-center">
              <View testID={`hero-${mode}-compare-${i}`} className="flex-1 rounded-sm bg-muted-foreground opacity-30"
                style={{ height: height(compareValues[i] ?? 0), maxWidth: 24 }} />
              <View testID={`hero-${mode}-bar-${i}`} className="flex-1 bg-primary rounded-sm" style={{ height: height(gross), maxWidth: 24 }} />
            </View>
          ))}
        </View>
        {hourly ? <View testID="hero-hour-labels" className="flex-row">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => <Text key={hour} className="flex-1 text-left text-xs text-muted-foreground">{`${String(hour).padStart(2, '0')}:00`}</Text>)}
        </View> : <View className="flex-row">
          {series.map((point, i) => <Text key={point.day} className="flex-1 text-center text-xs text-muted-foreground">
            {series.length <= 7 || i % Math.ceil(series.length / 7) === 0 || i === series.length - 1 ? date.format(new Date(`${point.day}T00:00:00Z`)) : ''}
          </Text>)}
        </View>}
      </View>
    </Card>
  );
}
