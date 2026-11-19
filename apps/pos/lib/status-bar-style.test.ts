import { expect, it } from 'vitest';
import { statusBarStyle } from './status-bar-style';

it('the status bar takes light text on the dark theme, dark text on light, and the device otherwise', () => {
  expect(statusBarStyle('dark')).toBe('light');
  expect(statusBarStyle('light')).toBe('dark');
  expect(statusBarStyle('system')).toBe('auto');
  expect(statusBarStyle('sepia')).toBe('auto');
});
