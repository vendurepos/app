// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { Uniwind } from 'uniwind';
import { printInLightScheme } from './print-light';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('uniwind', () => ({
  Uniwind: { setTheme: vi.fn(), hasAdaptiveThemes: true, currentTheme: 'dark' },
}));

let cleanup: () => void;
beforeEach(() => {
  Platform.OS = 'web';
  Object.assign(Uniwind, { hasAdaptiveThemes: true, currentTheme: 'dark' });
  vi.mocked(Uniwind.setTheme).mockClear();
});
afterEach(() => { cleanup(); });

it('printing switches to light and puts the system scheme back after', () => {
  cleanup = printInLightScheme();
  window.dispatchEvent(new Event('beforeprint'));
  expect(Uniwind.setTheme).toHaveBeenCalledExactlyOnceWith('light');
  window.dispatchEvent(new Event('afterprint'));
  expect(Uniwind.setTheme).toHaveBeenNthCalledWith(2, 'system');
  window.dispatchEvent(new Event('afterprint'));
  expect(Uniwind.setTheme).toHaveBeenCalledTimes(2);
});

it('a till fixed on dark goes back to dark after printing', () => {
  Object.assign(Uniwind, { hasAdaptiveThemes: false, currentTheme: 'dark' });
  cleanup = printInLightScheme();
  window.dispatchEvent(new Event('beforeprint'));
  expect(Uniwind.setTheme).toHaveBeenCalledExactlyOnceWith('light');
  Object.assign(Uniwind, { currentTheme: 'light' });
  window.dispatchEvent(new Event('afterprint'));
  expect(Uniwind.setTheme).toHaveBeenNthCalledWith(2, 'dark');
  expect(Uniwind.setTheme).toHaveBeenCalledTimes(2);
});

it('an afterprint without a beforeprint changes nothing', () => {
  cleanup = printInLightScheme();
  window.dispatchEvent(new Event('afterprint'));
  expect(Uniwind.setTheme).not.toHaveBeenCalled();
});

it('the cleanup stops listening for prints', () => {
  cleanup = printInLightScheme();
  window.dispatchEvent(new Event('beforeprint'));
  expect(Uniwind.setTheme).toHaveBeenCalledExactlyOnceWith('light');
  cleanup();
  vi.mocked(Uniwind.setTheme).mockClear();
  window.dispatchEvent(new Event('afterprint'));
  window.dispatchEvent(new Event('beforeprint'));
  expect(Uniwind.setTheme).not.toHaveBeenCalled();
});

it('does nothing on native', () => {
  Platform.OS = 'ios';
  cleanup = printInLightScheme();
  window.dispatchEvent(new Event('beforeprint'));
  window.dispatchEvent(new Event('afterprint'));
  expect(Uniwind.setTheme).not.toHaveBeenCalled();
});
