import { useEffect, useState, type JSX } from 'react';
import { Platform } from 'react-native';
import { FONT_SETTINGS, TYPE_SETS, fontFamilyStyle } from '@tallyui/theme';
import {
  Card, CardContent, CardHeader, CardTitle, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { UI_SCALES, UI_THEMES } from '@tallyui/pos';
import { ALL_FONT_FAMILIES, loadAppFonts } from './app-fonts';
import { FONT_LABELS, loadFont, saveFont } from './font-setting';
import { loadScale, saveScale } from './scale-setting';
import { applyTheme, loadTheme, saveTheme } from './theme-setting';

export function ThemeSettings(): JSX.Element {
  const [theme, setTheme] = useState(() => loadTheme());
  const [scale, setScale] = useState(() => loadScale());
  const [font, setFont] = useState(() => loadFont());
  useEffect(() => { loadAppFonts(ALL_FONT_FAMILIES).catch(() => undefined); }, []);
  return (
    <Card className="w-full max-w-[420px]">
      <CardHeader><CardTitle aria-level={2}>Appearance</CardTitle></CardHeader>
      <CardContent>
        <VStack space="lg">
          <Text>{"Choose how the app looks on this device. System follows the device's light or dark mode."}</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Theme" testID="theme"
            value={theme} onValueChange={(value) => {
              if (value === '') return;
              const theme = UI_THEMES.find((theme) => theme === value)!;
              saveTheme(theme);
              applyTheme(theme);
              setTheme(theme);
            }}>
            {UI_THEMES.map((item) => (
              <ToggleGroupItem key={item} value={item} testID={`theme-${item}`} className={item === theme ? 'bg-secondary' : undefined}>
                <Text>{item === 'system' ? 'System' : item === 'light' ? 'Light' : 'Dark'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text>{"Scale sets the size of text and controls. Auto picks one from the window's width."}</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Scale" testID="scale"
            value={scale} onValueChange={(value) => {
              if (value === '') return;
              const scale = UI_SCALES.find((scale) => scale === value)!;
              saveScale(scale);
              setScale(scale);
            }}>
            {UI_SCALES.map((item) => (
              <ToggleGroupItem key={item} value={item} testID={`scale-${item}`} className={item === scale ? 'bg-secondary' : undefined}>
                <Text>{item === 'auto' ? 'Auto' : item === 'compact' ? 'Compact' : item === 'regular' ? 'Regular' : 'Spacious'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Text testID="font-help">{"Fonts sets the typeface of the app's text on this device. Match theme uses the theme's own type, which is the system font."}</Text>
          <ToggleGroup type="single" className="flex-wrap justify-start" accessibilityLabel="Fonts" testID="font"
            value={font} onValueChange={(value) => {
              if (value === '') return;
              const id = FONT_SETTINGS.find((id) => id === value)!;
              saveFont(id);
              setFont(id);
            }}>
            {FONT_SETTINGS.map((id) => (
              <ToggleGroupItem key={id} value={id} testID={`font-${id}`} className={id === font ? 'bg-secondary' : undefined}>
                <Text style={id === 'auto' ? undefined : fontFamilyStyle(TYPE_SETS[id].body, Platform.OS === 'web')}>{FONT_LABELS[id]}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </VStack>
      </CardContent>
    </Card>
  );
}
