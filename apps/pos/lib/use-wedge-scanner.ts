import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

// The heuristic is WCPOS v2's (monorepo packages/core/src/screens/main/hooks/barcodes/use-barcode-detection.ts and the
// @wcpos/scanner wedge detector it drives), with its scanner registration's stricter burst rule
// (use-scanner-registration.ts:81-89): a gap at or above the threshold ends the burst, so every gap in a scan is fast.
/** A key this soon after the one before is scanner-fast: WCPOS's default barcode_scanning_avg_time_input_threshold. */
export const WEDGE_KEY_GAP_MS = 24;
/** A shorter burst is left alone: WCPOS's default barcode_scanning_min_chars. */
export const WEDGE_MIN_LENGTH = 8;

/**
 * Calls `onScan(code)` for a keyboard-wedge scan wherever the focus is: a burst of scanner-fast printable keys at least
 * WEDGE_MIN_LENGTH long, ended by a scanner-fast Enter. The scan's Enter goes no further, so it never presses a focused
 * button. As in WCPOS, a key typed into an input, textarea or contenteditable belongs to the typist whatever its speed,
 * and drops any burst begun outside it: a field handles its own Enter (the catalogue's search looks the code up).
 * Web only: a native hardware keyboard is out of scope, so on native this does nothing.
 */
export function useWedgeScanner(onScan: (code: string) => void) {
  const latest = useRef(onScan);
  useEffect(() => { latest.current = onScan; });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let burst = '';
    let lastKeyAt = -Infinity;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) {
        burst = '';
        return;
      }
      const fast = event.timeStamp - lastKeyAt < WEDGE_KEY_GAP_MS;
      if (event.key === 'Enter') {
        const code = burst;
        burst = '';
        if (!fast || code.length < WEDGE_MIN_LENGTH) return;
        event.preventDefault();
        event.stopPropagation();
        latest.current(code);
      } else if (event.key.length === 1) {
        // Shift and the other named keys neither extend nor end a burst.
        burst = fast ? burst + event.key : event.key;
        lastKeyAt = event.timeStamp;
      }
    }
    // Capture, so the scan's Enter is stopped before a focused control sees it.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
