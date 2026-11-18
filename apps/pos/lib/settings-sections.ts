export type SettingsSectionId = 'general' | 'tax' | 'register' | 'printing' | 'customer-display' | 'barcode' | 'theme' | 'sync-log';
export interface SettingsSection { id: SettingsSectionId; label: string }
/**
 * The Settings sections in v2's order (General, Tax, …, Printing, …, Barcode Scanning), with this till's own Register
 * and Sync log. Printing only where the till prints (the web); Customer display only where the store advertises one.
 */
export function settingsSections({ printing, customerDisplay }: { printing: boolean; customerDisplay: boolean }): SettingsSection[] {
  return [
    { id: 'general', label: 'General' },
    { id: 'tax', label: 'Tax' },
    { id: 'register', label: 'Register' },
    ...(printing ? [{ id: 'printing' as const, label: 'Printing' }] : []),
    ...(customerDisplay ? [{ id: 'customer-display' as const, label: 'Customer display' }] : []),
    { id: 'barcode', label: 'Barcode scanning' },
    { id: 'theme', label: 'Theme' },
    { id: 'sync-log', label: 'Sync log' },
  ];
}
