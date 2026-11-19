import { useEffect, useMemo } from 'react';
import type { ViewfinderProps } from '@tallyui/components';
import { CAMERA_BARCODE_TYPES } from '@tallyui/pos';
import { barcodeHandler, pickNativeCamera, type ExpoCameraLike, type NativeCamera } from './native-camera-core';

// The only file that imports expo-camera, and lazily: where the native module is absent the scan button is hidden.
function make({ CameraView, useCameraPermissions }: ExpoCameraLike): NativeCamera {
  function Viewfinder({ onDetected, onStatus }: ViewfinderProps) {
    useEffect(() => { onStatus('initializing'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const handler = useMemo(() => barcodeHandler(onDetected), [onDetected]);
    return (
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: [...CAMERA_BARCODE_TYPES] }}
        onBarcodeScanned={handler} onCameraReady={() => onStatus('scanning')} onMountError={() => onStatus('camera-unavailable')} />
    );
  }
  function usePermission() {
    const [perm, requestPermission] = useCameraPermissions();
    return { granted: perm?.granted ?? false, request: () => { void requestPermission(); } };
  }
  return { Viewfinder, usePermission };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const nativeCamera = pickNativeCamera(() => require('expo-camera'), make);
