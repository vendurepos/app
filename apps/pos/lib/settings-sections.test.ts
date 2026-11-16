import { expect, it } from 'vitest';
import { settingsSections } from './settings-sections';

it("lists v2's sections with the till's own Register and Sync log", () => {
  const sections = settingsSections({ printing: true });
  expect(sections.map(s => s.id)).toEqual(['general', 'register', 'printing', 'barcode', 'theme', 'sync-log']);
  expect(sections.map(s => s.label)).toEqual(['General', 'Register', 'Printing', 'Barcode scanning', 'Theme', 'Sync log']);
});

it('leaves Printing out where the till cannot print', () => {
  expect(settingsSections({ printing: false }).map(s => s.id)).toEqual(['general', 'register', 'barcode', 'theme', 'sync-log']);
});
