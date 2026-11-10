import { useState, type JSX } from 'react';
import { Platform } from 'react-native';
import { Button, Input, InputField, Label, Text } from '@tallyui/components';
import { loadScannerAffixes, loadScanSounds, saveScannerAffixes, saveScanSounds } from './scanner-settings';

/** Settings › Scanner: the prefix and suffix taken off each scan, and scan sounds. */
export function ScannerExtraSettings(): JSX.Element {
  const [affixes, setAffixes] = useState(() => loadScannerAffixes());
  const [sounds, setSounds] = useState(() => loadScanSounds());
  return <>
    <Label nativeID="scanner-prefix-label">Prefix the scanner adds</Label>
    <Input><InputField testID="scanner-prefix" accessibilityLabelledBy="scanner-prefix-label"
      maxLength={8} autoCapitalize="none" autoCorrect={false} value={affixes.prefix} onChangeText={(prefix) => {
        const next = { ...affixes, prefix };
        saveScannerAffixes(next);
        setAffixes(next);
      }} /></Input>
    <Label nativeID="scanner-suffix-label">Suffix the scanner adds</Label>
    <Input><InputField testID="scanner-suffix" accessibilityLabelledBy="scanner-suffix-label"
      maxLength={8} autoCapitalize="none" autoCorrect={false} value={affixes.suffix} onChangeText={(suffix) => {
        const next = { ...affixes, suffix };
        saveScannerAffixes(next);
        setAffixes(next);
      }} /></Input>
    <Text>Taken off each scan before the lookup. Leave both empty if your scanner adds nothing.</Text>
    {Platform.OS === 'web' && <>
      <Text>{"Beep when a scan adds a product, and a lower tone when it doesn't."}</Text>
      <Button testID="scan-sounds-toggle" onPress={() => {
        saveScanSounds(!sounds);
        setSounds(!sounds);
      }}><Text>Scan sounds: {sounds ? 'On' : 'Off'}</Text></Button>
    </>}
  </>;
}
