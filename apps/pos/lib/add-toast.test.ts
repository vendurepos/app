import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADD_TOAST_MS, createAddToastTimer } from './add-toast';

vi.mock('react-native', () => ({ View: () => null }));
vi.mock('@tallyui/components', () => ({ Toast: () => null, ToastTitle: () => null }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('show sets the line and it clears after ADD_TOAST_MS', () => {
  const onChange = vi.fn();
  const timer = createAddToastTimer(onChange);
  timer.show('a');
  expect(onChange).toHaveBeenLastCalledWith('a');
  vi.advanceTimersByTime(ADD_TOAST_MS - 1);
  expect(onChange).toHaveBeenLastCalledWith('a');
  vi.advanceTimersByTime(1);
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it('a second show replaces the line and restarts the timer', () => {
  const onChange = vi.fn();
  const timer = createAddToastTimer(onChange);
  timer.show('a');
  vi.advanceTimersByTime(2000);
  timer.show('b');
  vi.advanceTimersByTime(2000);
  expect(onChange).toHaveBeenLastCalledWith('b');
  expect(onChange).not.toHaveBeenCalledWith(null);
  vi.advanceTimersByTime(500);
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it('a longer timer still shows at 9 999 ms and clears at 10 000', () => {
  const onChange = vi.fn();
  const timer = createAddToastTimer(onChange, 10_000);
  timer.show('a');
  vi.advanceTimersByTime(9_999);
  expect(onChange).toHaveBeenLastCalledWith('a');
  vi.advanceTimersByTime(1);
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it('hide clears the line at once and cancels the pending clear', () => {
  const onChange = vi.fn();
  const timer = createAddToastTimer(onChange);
  timer.show('a');
  timer.hide();
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(onChange).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(ADD_TOAST_MS);
  expect(onChange).toHaveBeenCalledTimes(2);
});

it('dispose cancels the pending clear', () => {
  const onChange = vi.fn();
  const timer = createAddToastTimer(onChange);
  timer.show('a');
  timer.dispose();
  vi.advanceTimersByTime(ADD_TOAST_MS);
  expect(onChange).not.toHaveBeenCalledWith(null);
});
