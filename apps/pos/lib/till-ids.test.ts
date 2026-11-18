import { expect, it } from 'vitest';
import {
  BOUND_REGISTER_ID_KEY, bindRegister, boundRegisterId, DEVICE_ID_KEY, deviceId, DISPLAY_DEVICE_ID_KEY, displayDeviceId,
  OWN_REGISTER_ID_KEY, ownRegisterId, rebindRegister,
} from './till-ids';

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

it('rebinds the register to a fresh id without changing the device id', () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  };
  const device = deviceId(storage);
  const drawer = boundRegisterId(storage);
  const rebound = rebindRegister(storage);
  expect(rebound).not.toBe(drawer);
  expect(boundRegisterId(storage)).toBe(rebound);
  expect(deviceId(storage)).toBe(device);
  expect(Object.fromEntries(stored)).toEqual({ [DEVICE_ID_KEY]: device, [BOUND_REGISTER_ID_KEY]: rebound });
});

const keyStorage = () => {
  const stored = new Map<string, string>();
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  };
};

it('keeps the till\'s own register when Settings binds it to another (CHECKLIST 6.6)', () => {
  const storage = keyStorage();
  const own = ownRegisterId(storage);
  expect(own).toBe(boundRegisterId(storage));
  bindRegister(storage, 'front-counter');
  expect(boundRegisterId(storage)).toBe('front-counter');
  expect(ownRegisterId(storage)).toBe(own);
  expect(OWN_REGISTER_ID_KEY).toBe('vendurepos.own_register_id');
});

it('moves the own register to the fresh id only when rebinding away from the own register', () => {
  const storage = keyStorage();
  const own = ownRegisterId(storage);
  const fresh = rebindRegister(storage);
  expect(fresh).not.toBe(own);
  expect(ownRegisterId(storage)).toBe(fresh);
  bindRegister(storage, 'front-counter');
  const rebound = rebindRegister(storage);
  expect(rebound).not.toBe('front-counter');
  expect(ownRegisterId(storage)).toBe(fresh);
});

it('mints the display device id once, apart from the device id the orders carry', () => {
  const storage = keyStorage();
  const display = displayDeviceId(storage);
  expect(displayDeviceId(storage)).toBe(display);
  expect(display).not.toBe(deviceId(storage));
  expect(storage.getItem(DISPLAY_DEVICE_ID_KEY)).toBe(display);
  expect(DISPLAY_DEVICE_ID_KEY).toBe('vendurepos.display_device_id');
});
