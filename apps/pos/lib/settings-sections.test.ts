import { expect, it } from 'vitest';
import { settingsSections } from './settings-sections';

it("lists v2's sections with the till's own Register and Sync log", () => {
  const sections = settingsSections({ printing: true, customerDisplay: false });
  expect(sections.map(s => s.id)).toEqual(['general', 'tax', 'register', 'printing', 'barcode', 'theme', 'sync-log']);
  expect(sections.map(s => s.label)).toEqual(['General', 'Tax', 'Register', 'Printing', 'Barcode scanning', 'Theme', 'Sync log']);
});

it('leaves Printing out where the till cannot print', () => {
  expect(settingsSections({ printing: false, customerDisplay: false }).map(s => s.id)).toEqual(['general', 'tax', 'register', 'barcode', 'theme', 'sync-log']);
});

it('lists Customer display after Printing only where the store advertises one, on the web and on native', () => {
  const web = settingsSections({ printing: true, customerDisplay: true });
  expect(web.map(s => s.id)).toEqual(['general', 'tax', 'register', 'printing', 'customer-display', 'barcode', 'theme', 'sync-log']);
  expect(web.find(s => s.id === 'customer-display')?.label).toBe('Customer display');
  expect(settingsSections({ printing: false, customerDisplay: true }).map(s => s.id))
    .toEqual(['general', 'tax', 'register', 'customer-display', 'barcode', 'theme', 'sync-log']);
});
