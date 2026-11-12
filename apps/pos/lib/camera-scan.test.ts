import { beforeEach, expect, it, vi } from 'vitest';
import { createCameraScanner } from './camera-scan';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

let at: number;
const onScan = vi.fn<(code: string) => boolean | void>();
const onAccepted = vi.fn();
const minLength = vi.fn(() => 8);
const sounds = vi.fn(() => false);
const play = vi.fn();
const now = () => at;
beforeEach(() => {
  at = 0;
  onScan.mockReset().mockReturnValue(true);
  onAccepted.mockReset();
  minLength.mockReset().mockReturnValue(8);
  sounds.mockReset().mockReturnValue(false);
  play.mockReset();
});

it('one read is passed to onScan once and counted', () => {
  const scanner = createCameraScanner({ onScan, onAccepted, minLength, sounds, play, now });
  scanner.offer(' ABC12345 ');
  expect(onScan).toHaveBeenCalledExactlyOnceWith('ABC12345');
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(onScan.mock.invocationCallOrder[0]);
});

it('an item resting in view is added once', () => {
  const scanner = createCameraScanner({ onScan, onAccepted, minLength, sounds, play, now });
  for (at = 0; at <= 2000; at += 200) scanner.offer('ABC12345');
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(onAccepted).toHaveBeenCalledTimes(1);
  at = 3300;
  scanner.offer('ABC12345');
  expect(onScan).toHaveBeenCalledTimes(2);
  expect(onAccepted).toHaveBeenCalledTimes(2);
});

it('a different code is accepted at once', () => {
  const scanner = createCameraScanner({ onScan, minLength, sounds, play, now });
  scanner.offer('ABC12345');
  scanner.offer('DEF12345');
  expect(onScan.mock.calls).toEqual([['ABC12345'], ['DEF12345']]);
});

it('reset lets the same code in again at once', () => {
  const scanner = createCameraScanner({ onScan, minLength, sounds, play, now });
  scanner.offer('ABC12345');
  scanner.reset();
  scanner.offer('ABC12345');
  expect(onScan.mock.calls).toEqual([['ABC12345'], ['ABC12345']]);
});

it('a read shorter than the shortest scan length is dropped', () => {
  const scanner = createCameraScanner({ onScan, onAccepted, minLength, sounds, play, now });
  scanner.offer(' 12345 ');
  expect(onScan).not.toHaveBeenCalled();
  expect(onAccepted).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  minLength.mockReturnValue(4);
  scanner.offer('12345');
  expect(onScan).toHaveBeenCalledExactlyOnceWith('12345');
});

it('a bad EAN-13 check digit is dropped', () => {
  const scanner = createCameraScanner({ onScan, onAccepted, minLength, sounds, play, now });
  scanner.offer('2000000000018', 'ean13');
  expect(onScan).not.toHaveBeenCalled();
  expect(onAccepted).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  scanner.offer('2000000000015', 'ean13');
  expect(onScan).toHaveBeenCalledExactlyOnceWith('2000000000015');
});

it('sounds: hit when onScan added, miss otherwise, nothing when off', () => {
  const scanner = createCameraScanner({ onScan, minLength, sounds, play, now });
  sounds.mockReturnValue(true);
  scanner.offer('ABC12345');
  expect(play).toHaveBeenLastCalledWith('hit');
  expect(onScan.mock.invocationCallOrder[0]).toBeLessThan(play.mock.invocationCallOrder[0]);
  onScan.mockReturnValue(false);
  scanner.offer('DEF12345');
  expect(play).toHaveBeenLastCalledWith('miss');
  onScan.mockReturnValue(undefined);
  scanner.offer('GHI12345');
  expect(play.mock.calls).toEqual([['hit'], ['miss'], ['miss']]);
  sounds.mockReturnValue(false);
  scanner.offer('JKL12345');
  expect(play).toHaveBeenCalledTimes(3);
});

it('the prefix and suffix are not stripped', () => {
  const scanner = createCameraScanner({ onScan, minLength, sounds, play, now });
  scanner.offer('*ABC12345#');
  expect(onScan).toHaveBeenCalledExactlyOnceWith('*ABC12345#');
});
