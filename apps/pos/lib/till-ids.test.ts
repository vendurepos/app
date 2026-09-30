import { expect, it } from 'vitest';
import { BOUND_REGISTER_ID_KEY, boundRegisterId, DEVICE_ID_KEY, deviceId } from './till-ids';

it('mints the bound register (the drawer) once per device, under its own key, apart from the device id', () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  const device = deviceId(storage);
  const drawer = boundRegisterId(storage);
  expect(drawer).not.toBe(device);
  expect(boundRegisterId(storage)).toBe(drawer);
  expect(deviceId(storage)).toBe(device);
  expect(Object.fromEntries(stored)).toEqual({ [DEVICE_ID_KEY]: device, [BOUND_REGISTER_ID_KEY]: drawer });
  expect(BOUND_REGISTER_ID_KEY).toBe('vendurepos.bound_register_id');
  // register_sessions, closures and register_commands hold a register id of at most 36 characters.
  expect(drawer.length).toBeLessThanOrEqual(36);
});
