/** The native status bar's text colour for the applied theme: light text on dark, dark on light, else the device's. */
export function statusBarStyle(theme: string): 'light' | 'dark' | 'auto' {
  if (theme === 'dark') return 'light';
  if (theme === 'light') return 'dark';
  return 'auto';
}
