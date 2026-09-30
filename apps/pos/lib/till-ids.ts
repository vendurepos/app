import { getDeviceId } from '@tallyui/pos';

type IdStorage = Parameters<typeof getDeviceId>[0];

// The till's device id, minted once per device (medusapos uses 'medusapos.register_id'): each order's registerId and
// each command's deviceId.
export const DEVICE_ID_KEY = 'vendurepos.register_id';
// The cash drawer this till is bound to, minted once per device: useRegisterSession's registerId (a register in
// TallyUI's sense, INTEGRATION.md), kept apart from the device id. One drawer per till, so no picker.
export const BOUND_REGISTER_ID_KEY = 'vendurepos.bound_register_id';

export const deviceId = (storage: IdStorage) => getDeviceId(storage, DEVICE_ID_KEY);
export const boundRegisterId = (storage: IdStorage) => getDeviceId(storage, BOUND_REGISTER_ID_KEY);
