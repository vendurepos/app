import type { ComponentType } from 'react';
import type { ViewfinderProps } from '@tallyui/components';

/** The native camera seam for TallyUI's scanner panel (1.7b): its viewfinder and its permission hook. */
export interface NativeCamera {
  Viewfinder: ComponentType<ViewfinderProps>;
  usePermission(): { granted: boolean; request: () => void };
}

/** What we use of expo-camera, so the pick is testable without the native module. */
export interface ExpoCameraLike {
  CameraView: ComponentType<any>;
  useCameraPermissions: () => [{ granted: boolean } | null, () => unknown];
}

/** The native camera, or undefined where the module is absent (no camera button then). */
export function pickNativeCamera(load: () => unknown, make: (mod: ExpoCameraLike) => NativeCamera): NativeCamera | undefined {
  let mod: Partial<ExpoCameraLike> | null | undefined;
  try { mod = load() as typeof mod; } catch { return undefined; }
  if (typeof mod?.CameraView !== 'function' || typeof mod.useCameraPermissions !== 'function') return undefined;
  return make(mod as ExpoCameraLike);
}

/** expo-camera's onBarcodeScanned, fed to the panel's onDetected; an empty read is dropped. */
export function barcodeHandler(onDetected: ViewfinderProps['onDetected']): (result: { data?: string; type?: string }) => void {
  return (result) => {
    if (typeof result.data !== 'string' || result.data === '') return;
    onDetected(result.data, result.type);
  };
}

/** The camera scan button shows on web, and on native only where the camera module loaded. */
export function cameraScanShown(os: string, nativeCamera: NativeCamera | undefined): boolean {
  return os === 'web' || nativeCamera !== undefined;
}

/** A hook fixed at load: the native permission hook, or one that gives undefined (web, no module). */
export function permissionHook(nc: NativeCamera | undefined) {
  return nc ? nc.usePermission : () => undefined;
}
