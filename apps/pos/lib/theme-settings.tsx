import { useState, type JSX } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, Text, ToggleGroup, ToggleGroupItem, VStack,
} from '@tallyui/components';
import { UI_THEMES } from '@tallyui/pos';
import { applyTheme, loadTheme, saveTheme } from './theme-setting';

export function ThemeSettings(): JSX.Element {
  const [theme, setTheme] = useState(() => loadTheme());
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
            {UI_THEMES.map((theme) => (
              <ToggleGroupItem key={theme} value={theme} testID={`theme-${theme}`}>
                <Text>{theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}</Text>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </VStack>
      </CardContent>
    </Card>
  );
}
