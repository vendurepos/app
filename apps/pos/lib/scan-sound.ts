export type ScanSound = 'hit' | 'miss';

// WCPOS v2's classic tones (packages/core/src/screens/main/hooks/barcodes/play-scan-sound.web.ts).
const TONES = {
  hit: { wave: 'sine', tones: [{ freq: 880, duration: 0.06 }, { freq: 1320, duration: 0.09 }] },
  miss: { wave: 'square', tones: [{ freq: 330, duration: 0.11 }, { freq: 220, duration: 0.13 }] },
} as const;
const VOLUME = 0.15;
let context: AudioContext | undefined;

/** A short Web Audio tone for a scan (WCPOS v2's classic tones). Best effort: silent without Web Audio, never throws. */
export function playScanSound(sound: ScanSound): void {
  try {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContext) return;
    const active = context ??= new AudioContext();
    const play = () => {
      let start = active.currentTime;
      const { wave, tones } = TONES[sound];
      for (const { freq, duration } of tones) {
        const oscillator = active.createOscillator();
        const gain = active.createGain();
        oscillator.type = wave;
        oscillator.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(VOLUME, start + 0.01);
        gain.gain.linearRampToValueAtTime(0, start + duration);
        oscillator.connect(gain);
        gain.connect(active.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
        start += duration;
      }
    };
    if (active.state === 'suspended') void active.resume().then(play).catch(() => {});
    else play();
  } catch { /* Sound is best effort, including browsers that block audio. */ }
}
