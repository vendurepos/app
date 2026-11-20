import { useEffect, useRef } from 'react';
import { useScanHub, type ScanEvent, type ScanSourceKind } from '@tallyui/pos';
import type { Observable, Subscription } from 'rxjs';
import { loadScanSounds } from './scanner-settings';
import { playScanSound } from './scan-sound';

export function routeDeviceScans(events$: Observable<ScanEvent>, opts: {
  isActive(): boolean; handle(code: string, kind: ScanSourceKind): void;
}): Subscription {
  return events$.subscribe((event) => {
    if (opts.isActive() && event.source.kind !== 'wedge' && event.source.kind !== 'camera') opts.handle(event.code, event.source.kind);
  });
}

export function useDeviceScans(onScan: (code: string, kind: ScanSourceKind) => boolean | void | null, active: boolean) {
  const hub = useScanHub();
  const latest = useRef(onScan);
  useEffect(() => { latest.current = onScan; });
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; });
  useEffect(() => {
    const subscription = routeDeviceScans(hub.events$, {
      isActive: () => activeRef.current,
      handle: (code, kind) => {
        const result = latest.current(code, kind);
        if (result !== null && loadScanSounds()) playScanSound(result === true ? 'hit' : 'miss');
      },
    });
    return () => subscription.unsubscribe();
  }, [hub]);
}
