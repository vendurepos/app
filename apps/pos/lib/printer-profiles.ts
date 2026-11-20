import { PAPER_COLUMNS, type PrinterProfile, type ReceiptPaper } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const PRINTER_PROFILES_KEY = 'vendurepos.printer.profiles';
export type SavedPrinterConnection = 'network' | 'bluetooth' | 'usb';
export const PRINTER_CONNECTIONS: ReadonlyArray<{ value: SavedPrinterConnection; label: string }> = [
  { value: 'network', label: 'Network' },
  { value: 'bluetooth', label: 'Bluetooth' },
  { value: 'usb', label: 'USB' },
];
export const DEFAULT_PRINTER_PORT = 9100; // v2's default raw-print port, as PrinterProfile's doc says.

export function loadPrinterProfiles(store: KeyValueStore = defaultStore()): PrinterProfile[] {
  try {
    const saved: unknown = JSON.parse(store.getItem(PRINTER_PROFILES_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((profile): profile is PrinterProfile =>
      profile !== null && typeof profile === 'object' && typeof profile.id === 'string' &&
      typeof profile.name === 'string' && profile.name.length > 0 &&
      PRINTER_CONNECTIONS.some(({ value }) => value === profile.connectionType) &&
      (profile.columns === undefined || typeof profile.columns === 'number')) : [];
  } catch {
    return [];
  }
}

export function savePrinterProfile(profile: PrinterProfile, store: KeyValueStore = defaultStore()): void {
  const profiles = loadPrinterProfiles(store);
  const index = profiles.findIndex((saved) => saved.id === profile.id);
  if (index < 0) profiles.push(profile); else profiles[index] = profile;
  store.setItem(PRINTER_PROFILES_KEY, JSON.stringify(profiles));
}

export function removePrinterProfile(id: string, store: KeyValueStore = defaultStore()): void {
  store.setItem(PRINTER_PROFILES_KEY, JSON.stringify(loadPrinterProfiles(store).filter((profile) => profile.id !== id)));
}

export function printerPaper(profile: PrinterProfile): ReceiptPaper {
  return profile.columns === PAPER_COLUMNS['58mm'] ? '58mm' : '80mm';
}

export function printerSummary(profile: PrinterProfile): string {
  const address = profile.address && profile.connectionType === 'network' && profile.port
    ? `${profile.address}:${profile.port}` : profile.address;
  return [PRINTER_CONNECTIONS.find(({ value }) => value === profile.connectionType)?.label,
    address, printerPaper(profile) === '58mm' ? '58 mm' : '80 mm'].filter(Boolean).join(' · ');
}
