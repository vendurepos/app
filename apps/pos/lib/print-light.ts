import { Platform } from 'react-native';
import { Uniwind } from 'uniwind';

/** Prints in the light scheme: a receipt is black on white paper whatever the screen shows. Web only; returns the cleanup. */
export function printInLightScheme(): () => void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};

  let restoreTheme: 'system' | 'light' | 'dark' | undefined;
  const beforePrint = () => {
    restoreTheme = Uniwind.hasAdaptiveThemes ? 'system' : Uniwind.currentTheme;
    Uniwind.setTheme('light');
  };
  const afterPrint = () => {
    if (restoreTheme === undefined) return;
    Uniwind.setTheme(restoreTheme);
    restoreTheme = undefined;
  };
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  return () => {
    window.removeEventListener('beforeprint', beforePrint);
    window.removeEventListener('afterprint', afterPrint);
  };
}
