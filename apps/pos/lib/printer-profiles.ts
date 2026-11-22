import { PAPER_COLUMNS, type PrinterProfile, type ReceiptPaper } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const PRINTER_PROFILES_KEY = 'vendurepos.printer.profiles';
export type SavedPrinterConnection = 'network' | 'bluetooth' | 'usb';
export const PRINTER_CONNECTIONS: ReadonlyArray<{ value: SavedPrinterConnection; label: string }> = [
  { value: 'network', label: 'Network' },
  { value: 'bluetooth', label: 'Bluetooth' },
  { value: 'usb', label: 'USB' },
];
export type SavedPrinterVendor = NonNullable<PrinterProfile['vendor']>;
// A network printer's make; PrinterProfile reads a missing vendor as `generic`.
export const PRINTER_VENDORS: readonly { value: SavedPrinterVendor; label: string }[] = [
  { value: 'epson', label: 'Epson' },
  { value: 'star', label: 'Star' },
  { value: 'generic', label: 'Other' },
];
export const DEFAULT_PRINTER_PORT = 9100; // v2's default raw-print port, as PrinterProfile's doc says.

// An unknown vendor is dropped, not the printer: the rest of the profile still holds.
function withKnownVendor(profile: PrinterProfile): PrinterProfile {
  if (profile.vendor === undefined || PRINTER_VENDORS.some(({ value }) => value === profile.vendor)) return profile;
  const kept = { ...profile };
  delete kept.vendor;
  return kept;
}

export function loadPrinterProfiles(store: KeyValueStore = defaultStore()): PrinterProfile[] {
  try {
    const saved: unknown = JSON.parse(store.getItem(PRINTER_PROFILES_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((profile): profile is PrinterProfile =>
      profile !== null && typeof profile === 'object' && typeof profile.id === 'string' &&
      typeof profile.name === 'string' && profile.name.length > 0 &&
      PRINTER_CONNECTIONS.some(({ value }) => value === profile.connectionType) &&
      (profile.columns === undefined || typeof profile.columns === 'number')).map(withKnownVendor) : [];
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
  const network = profile.connectionType === 'network';
  const address = profile.address && network && profile.port ? `${profile.address}:${profile.port}` : profile.address;
  return [PRINTER_CONNECTIONS.find(({ value }) => value === profile.connectionType)?.label,
    network ? PRINTER_VENDORS.find(({ value }) => value === (profile.vendor ?? 'generic'))?.label : undefined,
    address, printerPaper(profile) === '58mm' ? '58 mm' : '80 mm'].filter(Boolean).join(' · ');
}
