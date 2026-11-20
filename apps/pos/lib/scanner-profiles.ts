import type { ScannerConnectionType, ScannerProfile, ScannerProfileStore } from '@tallyui/pos';
import { defaultStore, type KeyValueStore } from './session';

export const SCANNER_PROFILES_KEY = 'vendurepos.scanner.profiles';

function readProfiles(store: KeyValueStore): ScannerProfile[] {
  try {
    const saved: unknown = JSON.parse(store.getItem(SCANNER_PROFILES_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((profile): profile is ScannerProfile =>
      profile && typeof profile.deviceKey === 'string' && typeof profile.connectionType === 'string') : [];
  } catch {
    return [];
  }
}

export function scannerProfileStore(store: KeyValueStore = defaultStore()): ScannerProfileStore {
  return {
    read: async (types) => readProfiles(store).filter((profile) => types.includes(profile.connectionType)),
    save: async (profile) => {
      const profiles = readProfiles(store);
      const index = profiles.findIndex((saved) => saved.deviceKey === profile.deviceKey);
      if (index < 0) profiles.push(profile); else profiles[index] = profile;
      store.setItem(SCANNER_PROFILES_KEY, JSON.stringify(profiles));
    },
  };
}

export function forgetScannerProfiles(types: readonly ScannerConnectionType[], store: KeyValueStore = defaultStore()): void {
  store.setItem(SCANNER_PROFILES_KEY, JSON.stringify(readProfiles(store).filter((profile) => !types.includes(profile.connectionType))));
}
