import { useMemo, useRef, useState } from 'react';
import { createScanSession } from '@tallyui/pos';
import { loadScannerMinLength, loadScanSounds } from './scanner-settings';
import { playScanSound, type ScanSound } from './scan-sound';

export interface CameraScannerOptions {
  /** Sale's scan handler, the one the wedge uses: true means it added a product. */
  onScan: (code: string) => boolean | void;
  /** Each accepted read (the panel flashes on it). */
  onAccepted?: () => void;
  minLength?: () => number;
  sounds?: () => boolean;
  play?: (sound: ScanSound) => void;
  now?: () => number;
}
export interface CameraScanner { offer(code: string, symbology?: string): void; reset(): void }

export function createCameraScanner(options: CameraScannerOptions): CameraScanner {
  const { onScan, onAccepted, minLength = loadScannerMinLength, sounds = loadScanSounds, play = playScanSound, now } = options;
  const session = createScanSession({
    continuous: true,
    now,
    onAccept(code) {
      onAccepted?.();
      const added = onScan(code) === true;
      if (sounds()) play(added ? 'hit' : 'miss');
    },
  });
  return {
    offer(code, symbology) {
      const trimmed = code.trim();
      if (trimmed.length < minLength()) return;
      session.offer(trimmed, symbology);
    },
    reset: session.reset,
  };
}

export function useCameraScanner(onScan: (code: string) => boolean | void):
  { onDetected: (code: string, symbology?: string) => void; onOpen: () => void; scanCount: number } {
  const latest = useRef(onScan);
  latest.current = onScan;
  const [scanCount, setScanCount] = useState(0);
  const scanner = useMemo(() => createCameraScanner({
    onScan: (code) => latest.current(code),
    onAccepted: () => setScanCount((count) => count + 1),
  }), []);
  return { onDetected: scanner.offer, onOpen: scanner.reset, scanCount };
}
