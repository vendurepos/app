import { getDeviceId, type TillDeviceKeyStore } from '@tallyui/pos';
import type { KeyValueStore } from './session';

type IdStorage = Parameters<typeof getDeviceId>[0];
type KeyStorage = NonNullable<IdStorage>;

// The till's device id, minted once per device (medusapos uses 'medusapos.register_id'): each order's registerId and
// each command's deviceId.
export const DEVICE_ID_KEY = 'vendurepos.register_id';
// The cash drawer this till is bound to: useRegisterSession's registerId (a register in TallyUI's sense, INTEGRATION.md), kept apart from the device id. Minted once per device; Settings › General may bind it to another of the store's registers (CHECKLIST 6.6).
export const BOUND_REGISTER_ID_KEY = 'vendurepos.bound_register_id';

export const deviceId = (storage: IdStorage) => getDeviceId(storage, DEVICE_ID_KEY);
// The display seam's X-Tally-Device-Id is not bound to the session (plugin README, #304), and the register id is in every order's registerId and every command, which any cashier who reads orders sees: so the display id is a separate random UUID only this till holds (9.8b, desk note 5).
export const DISPLAY_DEVICE_ID_KEY = 'vendurepos.display_device_id';
export const displayDeviceId = (storage: IdStorage) => getDeviceId(storage, DISPLAY_DEVICE_ID_KEY);
// The display device's key (TallyUI#754), a credential for every till-side display call. It lives beside
// DISPLAY_DEVICE_ID_KEY in the same device-local store, so the id and its key are lost together, and neither is ever
// put in RxDB or replicated.
export const DISPLAY_DEVICE_KEY_KEY = 'vendurepos.display_device_key';

/** The display device key in this device's own store; createTillDevice loads, saves and clears it. */
export const displayDeviceKeys = (storage: KeyValueStore): TillDeviceKeyStore => ({
  load: async () => storage.getItem(DISPLAY_DEVICE_KEY_KEY),
  save: async (key) => { storage.setItem(DISPLAY_DEVICE_KEY_KEY, key); },
  clear: async () => { storage.removeItem(DISPLAY_DEVICE_KEY_KEY); },
});
export const boundRegisterId = (storage: IdStorage) => getDeviceId(storage, BOUND_REGISTER_ID_KEY);

// The register this till minted for itself, kept once the till binds to another (Settings › General, CHECKLIST 6.6).
export const OWN_REGISTER_ID_KEY = 'vendurepos.own_register_id';

/** This till's own register: the bound one until the till first binds to another. */
export const ownRegisterId = (storage: KeyStorage): string => {
  const own = storage.getItem(OWN_REGISTER_ID_KEY);
  if (own) return own;
  const bound = boundRegisterId(storage);
  storage.setItem(OWN_REGISTER_ID_KEY, bound);
  return bound;
};

/** Binds this till to a register picked in Settings, after recording its own. */
export const bindRegister = (storage: KeyStorage, id: string): void => {
  ownRegisterId(storage);
  storage.setItem(BOUND_REGISTER_ID_KEY, id);
};

/** Binds this till to a fresh register: after its conflict session is abandoned, the old id would only meet the same open session again. */
export const rebindRegister = (storage: IdStorage & { removeItem(key: string): void }) => {
  const own = storage.getItem(OWN_REGISTER_ID_KEY);
  const wasOwn = own !== null && own === storage.getItem(BOUND_REGISTER_ID_KEY);
  storage.removeItem(BOUND_REGISTER_ID_KEY);
  const fresh = boundRegisterId(storage);
  if (wasOwn) storage.setItem(OWN_REGISTER_ID_KEY, fresh);
  return fresh;
};
