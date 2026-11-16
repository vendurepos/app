export type SettingsSectionId = 'general' | 'register' | 'printing' | 'barcode' | 'theme' | 'sync-log';
export interface SettingsSection { id: SettingsSectionId; label: string }
/**
 * The Settings sections in v2's order (General, …, Printing, …, Barcode Scanning), with this till's own Register and
 * Sync log. Printing only where the till prints (the web).
 */
export function settingsSections({ printing }: { printing: boolean }): SettingsSection[] {
  return [
    { id: 'general', label: 'General' },
    { id: 'register', label: 'Register' },
    ...(printing ? [{ id: 'printing' as const, label: 'Printing' }] : []),
    { id: 'barcode', label: 'Barcode scanning' },
    { id: 'theme', label: 'Theme' },
    { id: 'sync-log', label: 'Sync log' },
  ];
}
