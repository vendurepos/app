import { describe, expect, it, vi } from 'vitest';
import { barcodeHandler, cameraScanShown, permissionHook, pickNativeCamera, type NativeCamera } from './native-camera-core';
import { nativeCamera } from './native-camera';

const fake: NativeCamera = { Viewfinder: () => null, usePermission: () => ({ granted: true, request: () => {} }) };
const CameraView = () => null;
const useCameraPermissions = () => [null, () => undefined] as const;

describe('pickNativeCamera', () => {
  it('gives undefined when the module fails to load or lacks CameraView or useCameraPermissions', () => {
    expect(pickNativeCamera(() => { throw new Error('no native module'); }, () => fake)).toBeUndefined();
    expect(pickNativeCamera(() => ({ useCameraPermissions }), () => fake)).toBeUndefined();
    expect(pickNativeCamera(() => ({ CameraView }), () => fake)).toBeUndefined();
  });
  it("gives make's result for a full module, made from that module", () => {
    const mod = { CameraView, useCameraPermissions };
    const make = vi.fn(() => fake);
    expect(pickNativeCamera(() => mod, make)).toBe(fake);
    expect(make).toHaveBeenCalledWith(mod);
  });
});

describe('native camera seam', () => {
  it('barcodeHandler forwards a read and drops an empty one', () => {
    const onDetected = vi.fn();
    const handle = barcodeHandler(onDetected);
    handle({ data: '4006381333931', type: 'ean13' });
    handle({ data: '' });
    handle({});
    expect(onDetected.mock.calls).toEqual([['4006381333931', 'ean13']]);
  });
  it('the scan button shows on web, and on native only with the camera module', () => {
    expect(cameraScanShown('web', undefined)).toBe(true);
    expect(cameraScanShown('ios', undefined)).toBe(false);
    expect(cameraScanShown('android', undefined)).toBe(false);
    expect(cameraScanShown('ios', fake)).toBe(true);
  });
  it('permissionHook is the native hook or one giving undefined; the web stub has no native camera', () => {
    expect(permissionHook(undefined)()).toBeUndefined();
    expect(permissionHook(fake)).toBe(fake.usePermission);
    expect(nativeCamera).toBeUndefined();
  });
});
