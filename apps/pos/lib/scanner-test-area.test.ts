import { expect, it, vi } from 'vitest';
import { describeKey } from './scanner-test-area';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: () => null }));
vi.mock('@tallyui/components', () => ({ Label: () => null, Text: () => null }));

it('describes a key with its gap from the key before, rounded to the millisecond', () => {
  expect(describeKey('T', 3.4)).toBe('"T" · 3 ms');
  expect(describeKey('Enter', 2)).toBe('Enter · 2 ms');
  expect(describeKey(' ', 10)).toBe('Space · 10 ms');
});

it('describes the first key, which has no gap, by its label alone', () => {
  expect(describeKey('7', Infinity)).toBe('"7"');
});
