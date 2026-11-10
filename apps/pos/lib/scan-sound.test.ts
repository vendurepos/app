// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let oscillators: { type: string; frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }[];
let state: string;
const resume = vi.fn();
beforeEach(() => {
  vi.resetModules();
  oscillators = [];
  state = 'running';
  resume.mockReset().mockImplementation(async () => { state = 'running'; });
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('AudioContext', class {
    get state() { return state; }
    currentTime = 1;
    destination = {};
    resume = resume;
    createOscillator() {
      const oscillator = { type: '', frequency: { setValueAtTime: vi.fn() }, connect() {}, start() {}, stop() {} };
      oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['hit', 880, 1320, 'sine', 0.06],
  ['miss', 330, 220, 'square', 0.11],
] as const)('a %s plays %i Hz then %i Hz %s tones', async (sound, first, second, wave, duration) => {
  const { playScanSound } = await import('./scan-sound');
  playScanSound(sound);
  expect(oscillators.map((oscillator) => oscillator.type)).toEqual([wave, wave]);
  expect(oscillators.map((oscillator) => oscillator.frequency.setValueAtTime.mock.calls)).toEqual([
    [[first, 1]], [[second, 1 + duration]],
  ]);
});

it('a suspended context resumes before it plays', async () => {
  state = 'suspended';
  const { playScanSound } = await import('./scan-sound');
  playScanSound('hit');
  expect(resume).toHaveBeenCalledOnce();
  expect(oscillators).toHaveLength(0);
  await Promise.resolve();
  expect(oscillators).toHaveLength(2);
});

it('without Web Audio it plays nothing and does not throw', async () => {
  vi.stubGlobal('AudioContext', undefined);
  const { playScanSound } = await import('./scan-sound');
  expect(() => playScanSound('hit')).not.toThrow();
  expect(oscillators).toHaveLength(0);
});

it('a context that throws never reaches the caller', async () => {
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('Audio blocked'); } });
  const { playScanSound } = await import('./scan-sound');
  expect(() => playScanSound('miss')).not.toThrow();
});
