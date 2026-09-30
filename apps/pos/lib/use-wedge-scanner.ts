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
 * A money field: every TallyUI amount input (cash tendered, the counted cash and tenders, the float, a movement amount,
 * a discount value) takes keyboardType="decimal-pad" or inputMode="decimal", which react-native-web renders as
 * inputmode="decimal"; no text field (search, reason, note, sign-in, customer) does.
 */
function moneyField(target: HTMLElement | null) {
  return target instanceof HTMLInputElement && target.getAttribute('inputmode') === 'decimal' ? target : null;
}

/** Sets a controlled input's value as typing does: the native setter, so React sees a change, then an input event. */
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Calls `onScan(code)` for a keyboard-wedge scan wherever the focus is: a burst of scanner-fast printable keys at least
 * WEDGE_MIN_LENGTH long, ended by a scanner-fast Enter. The scan's Enter goes no further, so it never presses a focused
 * button. As in WCPOS, a key typed into a text input, textarea or contenteditable belongs to the typist whatever its
 * speed, and drops any burst begun outside it: a field handles its own Enter (the catalogue's search looks the code up).
 * A money field is the exception (Front desk, 2026-09-30: a barcode in an amount is a money error): a burst into it is
 * a scan too, and leaves the field as it was; typing at human speed stays typing.
 * Web only: a native hardware keyboard is out of scope, so on native this does nothing.
 */
export function useWedgeScanner(onScan: (code: string) => void) {
  const latest = useRef(onScan);
  useEffect(() => { latest.current = onScan; });
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let burst = '';
    let lastKeyAt = -Infinity;
    // A burst into a money field: the field, its value before the burst, and the fast keys kept out of it.
    let field: HTMLInputElement | null = null;
    let before = '';
    let held = '';
    let release: ReturnType<typeof setTimeout> | undefined;
    // A fast run that turns out not to be a scan (two keys rolled together) is typing: its held keys go in at the caret.
    function flush() {
      clearTimeout(release);
      if (!field || !held) return;
      const start = field.selectionStart ?? field.value.length;
      setValue(field, field.value.slice(0, start) + held + field.value.slice(field.selectionEnd ?? start));
      field.setSelectionRange(start + held.length, start + held.length);
      held = '';
    }
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const money = moneyField(target);
      if (!money && (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable)) {
        burst = '';
        return;
      }
      const fast = event.timeStamp - lastKeyAt < WEDGE_KEY_GAP_MS && money === field;
      if (event.key === 'Enter') {
        const code = burst;
        burst = '';
        if (!fast || code.length < WEDGE_MIN_LENGTH) {
          flush();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (field) {
          clearTimeout(release);
          held = '';
          setValue(field, before);
        }
        latest.current(code);
      } else if (event.key.length === 1) {
        if (!fast) {
          flush();
          [field, before] = [money, money?.value ?? ''];
        }
        burst = fast ? burst + event.key : event.key;
        lastKeyAt = event.timeStamp;
        // The first key types (it may be the typist's); a fast key after it is held back until the burst is known.
        if (fast && field) {
          event.preventDefault();
          held += event.key;
          clearTimeout(release);
          release = setTimeout(flush, WEDGE_KEY_GAP_MS);
        }
      } else {
        // Shift and the other named keys neither extend nor end a burst, but act on what the field shows.
        flush();
      }
    }
    // Capture, so the scan's Enter is stopped before a focused control sees it.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(release);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
}
