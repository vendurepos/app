import type { NativeCamera } from './native-camera-core';

/** Web (and default): no native camera; the panel uses the browser's own. iOS/Android: native-camera.native.tsx. */
export const nativeCamera: NativeCamera | undefined = undefined;
