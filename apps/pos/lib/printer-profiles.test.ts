import { beforeEach, expect, it } from 'vitest';
import type { PrinterProfile } from '@tallyui/pos';
import type { KeyValueStore } from './session';
import { loadPrinterProfiles, PRINTER_PROFILES_KEY, printerPaper, printerSummary, removePrinterProfile, savePrinterProfile } from './printer-profiles';

let store: KeyValueStore;
const printer: PrinterProfile = { id: 'front', name: 'Front counter', connectionType: 'network', address: '192.168.1.50', port: 9100, columns: 42, vendor: 'epson' };
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('loads an empty store as no printers', () => {
  expect(loadPrinterProfiles(store)).toEqual([]);
});

it('round-trips a saved profile exactly', () => {
  savePrinterProfile(printer, store);
  expect(loadPrinterProfiles(store)).toEqual([printer]);
});

it('edits the same id without duplicating it or moving its position', () => {
  savePrinterProfile(printer, store);
  const edited = { ...printer, name: 'Back office' };
  savePrinterProfile(edited, store);
  expect(loadPrinterProfiles(store)).toEqual([edited]);
  const other = { ...printer, id: 'other' };
  savePrinterProfile(other, store);
  savePrinterProfile(printer, store);
  expect(loadPrinterProfiles(store)).toEqual([printer, other]);
});

it('removes only the requested id and leaves unknown ids unchanged', () => {
  const other = { ...printer, id: 'other' };
  savePrinterProfile(printer, store);
  savePrinterProfile(other, store);
  removePrinterProfile('unknown', store);
  expect(loadPrinterProfiles(store)).toEqual([printer, other]);
  removePrinterProfile(printer.id, store);
  expect(loadPrinterProfiles(store)).toEqual([other]);
});

it.each(['invalid JSON', '{}', '"x"'])('loads %s as no printers', (saved) => {
  store.setItem(PRINTER_PROFILES_KEY, saved);
  expect(loadPrinterProfiles(store)).toEqual([]);
});

it('loads unreadable storage as no printers', () => {
  store.getItem = () => { throw new Error('unreadable'); };
  expect(loadPrinterProfiles(store)).toEqual([]);
});

it('drops invalid entries and keeps valid entries in stored order', () => {
  const usb: PrinterProfile = { id: 'usb', name: 'USB printer', connectionType: 'usb' };
  store.setItem(PRINTER_PROFILES_KEY, JSON.stringify([
    null, 'printer', { ...printer, id: 1 }, { id: 'missing-name', connectionType: 'usb' },
    { ...printer, name: '' }, { ...printer, connectionType: 'system' }, printer,
    { ...printer, connectionType: 'cloud' }, { ...printer, columns: '42' }, usb,
  ]));
  expect(loadPrinterProfiles(store)).toEqual([printer, usb]);
});

it.each([[32, '58mm'], [42, '80mm'], [undefined, '80mm']] as const)('maps %s columns to %s', (columns, paper) => {
  expect(printerPaper({ ...printer, columns })).toBe(paper);
});

it('round-trips each vendor and still loads an old profile with none', () => {
  const { vendor: _, ...old } = printer;
  for (const profile of [printer, { ...printer, id: 'star', vendor: 'star' as const }, { ...printer, id: 'other', vendor: 'generic' as const }, { ...old, id: 'old' }]) {
    savePrinterProfile(profile, store);
  }
  expect(loadPrinterProfiles(store).map((profile) => profile.vendor)).toEqual(['epson', 'star', 'generic', undefined]);
});

it('drops an unknown vendor and keeps the rest of the profile', () => {
  store.setItem(PRINTER_PROFILES_KEY, JSON.stringify([{ ...printer, vendor: 'zebra' }]));
  const { vendor: _, ...rest } = printer;
  expect(loadPrinterProfiles(store)).toStrictEqual([rest]);
});

it('summarizes a network address with its make, port and paper width', () => {
  expect(printerSummary(printer)).toBe('Network · Epson · 192.168.1.50:9100 · 80 mm');
  expect(printerSummary({ ...printer, vendor: 'generic' })).toBe('Network · Other · 192.168.1.50:9100 · 80 mm');
});

it('summarizes USB without an address', () => {
  expect(printerSummary({ id: 'usb', name: 'USB printer', connectionType: 'usb', columns: 32 })).toBe('USB · 58 mm');
});
