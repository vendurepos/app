// @vitest-environment happy-dom
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWedgeScanner, WEDGE_KEY_GAP_MS, WEDGE_MIN_LENGTH } from './use-wedge-scanner';

// The hook runs outside a component here: its effects run at once, and each one's cleanup is kept for unmount().
vi.mock('react', async (importActual) => ({
  ...await importActual<typeof import('react')>(),
  useEffect: vi.fn(), useRef: (current: unknown) => ({ current }),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

// The dev store's mug barcode (dev/vendure-store/README.md).
const CODE = '2000000000015';
// A wedge's keys arrive a few ms apart.
const WEDGE_GAP_MS = 5;
const onScan = vi.fn();
// Enters that got past the listener to the focused element.
const enters = vi.fn();
let cleanups: (() => void)[];

function unmount() {
  for (const cleanup of cleanups.splice(0)) cleanup();
}

beforeEach(() => {
  vi.useFakeTimers();
  onScan.mockClear();
  enters.mockClear();
  cleanups = [];
  vi.mocked(useEffect).mockImplementation((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  document.body.addEventListener('keydown', (event) => { if (event.key === 'Enter') enters(); });
  useWedgeScanner(onScan);
});

afterEach(() => {
  unmount();
  document.body.replaceWith(document.createElement('body'));
  vi.useRealTimers();
});

/** Types `keys` then Enter (unless `enter` is false) at `target`, `gapMs` apart, as a keyboard or a wedge would. */
function type(keys: string, gapMs: number, target: Element = document.body, enter = true) {
  for (const key of enter ? [...keys, 'Enter'] : keys) {
    vi.advanceTimersByTime(gapMs);
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    // happy-dom has no default action: a key not prevented types into an input, at its end, as the browser would.
    if (target.dispatchEvent(event) && key.length === 1 && target instanceof HTMLInputElement) target.value += key;
  }
}

/** A money field as react-native-web renders TallyUI's amount inputs (keyboardType="decimal-pad"). */
function moneyInput(value: string) {
  const input = document.body.appendChild(document.createElement('input'));
  input.setAttribute('inputmode', 'decimal');
  input.value = value;
  return input;
}

it('takes a scanner-fast burst ended by Enter as a scan, and its Enter goes no further', () => {
  type(CODE, WEDGE_GAP_MS);
  expect(onScan.mock.calls).toEqual([[CODE]]);
  expect(enters).not.toHaveBeenCalled();
});

it('leaves typing at the threshold alone, Enter included', () => {
  type(CODE, WEDGE_KEY_GAP_MS);
  expect(onScan).not.toHaveBeenCalled();
  expect(enters).toHaveBeenCalledTimes(1);
});

it('leaves keys typed into an input to the input, however fast: 12 then Enter in a quantity is not a scan', () => {
  const input = document.body.appendChild(document.createElement('input'));
  type('12', WEDGE_GAP_MS, input);
  type(CODE, WEDGE_GAP_MS, input);
  expect(onScan).not.toHaveBeenCalled();
  expect(enters).toHaveBeenCalledTimes(2);
});

it('leaves a fast burst shorter than the minimum alone', () => {
  type(CODE.slice(0, WEDGE_MIN_LENGTH - 1), WEDGE_GAP_MS);
  expect(onScan).not.toHaveBeenCalled();
});

it('stops listening once unmounted', () => {
  unmount();
  type(CODE, WEDGE_GAP_MS);
  expect(onScan).not.toHaveBeenCalled();
  expect(enters).toHaveBeenCalledTimes(1);
});

it('takes a scanner-fast burst into a money field as a scan, leaving the field as it was', () => {
  const counted = moneyInput('100.00');
  const inputs = vi.fn();
  counted.addEventListener('input', () => inputs(counted.value));
  type('400638133393', WEDGE_GAP_MS, counted);
  expect(onScan.mock.calls).toEqual([['400638133393']]);
  expect(counted.value).toBe('100.00');
  // The code's keys after the first never reach the field: the only change it hears puts its value back.
  expect(inputs.mock.calls).toEqual([['100.00']]);
  expect(enters).not.toHaveBeenCalled();
});

it('leaves typing at human speed in a money field alone: 1, 2, 0 then Enter is 120', () => {
  const counted = moneyInput('');
  type('120', 150, counted);
  expect(onScan).not.toHaveBeenCalled();
  expect(counted.value).toBe('120');
  expect(enters).toHaveBeenCalledTimes(1);
});

it('puts two keys rolled together into a money field back in the field once the run ends', () => {
  const counted = moneyInput('');
  type('12', WEDGE_GAP_MS, counted, false);
  vi.advanceTimersByTime(WEDGE_KEY_GAP_MS);
  type('0', 150, counted);
  expect(counted.value).toBe('120');
  expect(onScan).not.toHaveBeenCalled();
});

it('leaves a scanner-fast burst into a text field such as the search to the field', () => {
  const search = document.body.appendChild(document.createElement('input'));
  search.setAttribute('role', 'searchbox');
  type('400638133393', WEDGE_GAP_MS, search);
  expect(onScan).not.toHaveBeenCalled();
  expect(search.value).toBe('400638133393');
  expect(enters).toHaveBeenCalledTimes(1);
});
