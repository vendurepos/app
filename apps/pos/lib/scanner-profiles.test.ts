import { beforeEach, expect, it } from 'vitest';
import type { ScannerProfile } from '@tallyui/pos';
import type { KeyValueStore } from './session';
import { forgetScannerProfiles, scannerProfileStore, SCANNER_PROFILES_KEY } from './scanner-profiles';

let store: KeyValueStore;
const hid: ScannerProfile = { deviceKey: 'hid-pos:scanner', connectionType: 'hid-pos', deviceName: 'HID scanner' };
const serial: ScannerProfile = { deviceKey: 'usb-serial:scanner', connectionType: 'usb-serial', deviceName: 'Serial scanner' };
beforeEach(() => {
  const data = new Map<string, string>();
  store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
});

it('reads an empty store', async () => {
  expect(await scannerProfileStore(store).read(['hid-pos'])).toEqual([]);
});
it('round-trips a HID profile only for its connection type', async () => {
  await scannerProfileStore(store).save(hid);
  expect(await scannerProfileStore(store).read(['hid-pos'])).toEqual([hid]);
  expect(await scannerProfileStore(store).read(['usb-serial'])).toEqual([]);
});
it('replaces the same device key with its new fields, keeping saved order', async () => {
  const profiles = scannerProfileStore(store);
  await profiles.save(hid);
  await profiles.save(serial);
  const renamed = { ...hid, name: 'Front desk', deviceName: 'Renamed scanner' };
  await profiles.save(renamed);
  expect(await profiles.read(['hid-pos', 'usb-serial'])).toEqual([renamed, serial]);
});
it.each(['not JSON', '{}', '[{"connectionType":"hid-pos"}]', '[{"deviceKey":"scanner"}]', '[null]'])('ignores invalid saved data: %s', async (value) => {
  store.setItem(SCANNER_PROFILES_KEY, value);
  expect(await scannerProfileStore(store).read(['hid-pos'])).toEqual([]);
});
it('forgets HID profiles and keeps serial profiles', async () => {
  const profiles = scannerProfileStore(store);
  await profiles.save(hid);
  await profiles.save(serial);
  forgetScannerProfiles(['hid-pos'], store);
  expect(await profiles.read(['hid-pos', 'usb-serial'])).toEqual([serial]);
});
