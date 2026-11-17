import { describe, expect, it } from 'vitest';
import { openSince } from './open-since';

describe('openSince', () => {
  it('shows only the time for today', () => {
    expect(openSince(new Date(2026, 10, 17, 14, 38), new Date(2026, 10, 17, 23, 59))).toBe('14:38');
  });

  it('pads the hours and minutes', () => {
    expect(openSince(new Date(2026, 10, 17, 3, 5), new Date(2026, 10, 17, 9, 0))).toBe('03:05');
  });

  it('includes the day for a register left open from yesterday', () => {
    expect(openSince(new Date(2026, 10, 16, 14, 38), new Date(2026, 10, 17, 9, 0))).toBe('Mon 16 Nov 14:38');
  });

  it('includes the day for the same day and month in another year', () => {
    expect(openSince(new Date(2025, 10, 17, 14, 38), new Date(2026, 10, 17, 9, 0))).toBe('Mon 17 Nov 14:38');
  });
});
