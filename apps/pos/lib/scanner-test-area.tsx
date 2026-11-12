import { useEffect, useState, type JSX } from 'react';
import { Platform, View } from 'react-native';
import { Label, Text } from '@tallyui/components';
import { useWedgeScanner } from './use-wedge-scanner';

/**
 * One keydown as the test area logs it: the key, then the gap since the key before. The gap is what the scanner's 24 ms
 * rule (WEDGE_KEY_GAP_MS) measures: a scan's keys all come in under it. The first key has no gap, so only its label shows.
 */
export function describeKey(key: string, gapMs: number): string {
  const label = key === 'Enter' ? 'Enter' : key === ' ' ? 'Space' : `"${key}"`;
  return Number.isFinite(gapMs) ? `${label} · ${Math.round(gapMs)} ms` : label;
}

/**
 * Settings › Scanner's test area, as WCPOS v2's Barcode Scanning Test: the last key the scanner sent and the code the
 * till's own detector (the same affixes, shortest length and sounds) found in it. Web only, as the wedge listener is.
 */
export function ScannerTestArea(): JSX.Element | null {
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let lastAt = -Infinity;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Keys typed into a field (the prefix, say) are the typist's, as the detector takes them.
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.key === 'Shift') return;
      setLastKey(describeKey(event.key, event.timeStamp - lastAt));
      lastAt = event.timeStamp;
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
  useWedgeScanner((detected) => {
    setCode(detected);
    return true;
  });
  if (Platform.OS !== 'web') return null;
  return <View className="gap-2 border-t border-border pt-3">
    <Text role="heading" aria-level={3} className="font-semibold">Barcode scanning test</Text>
    <Text className="text-sm text-muted-foreground">Scan a barcode here to check the settings above. Nothing is added to the sale.</Text>
    <Label>Last key</Label>
    <View className="rounded-md border border-border bg-muted px-3 py-2">
      <Text testID="scanner-test-key">{lastKey ?? 'None yet'}</Text>
    </View>
    <Label>Detected barcode</Label>
    <View className="rounded-md border border-border bg-muted px-3 py-2">
      <Text testID="scanner-test-code">{code ?? 'None yet'}</Text>
    </View>
  </View>;
}
