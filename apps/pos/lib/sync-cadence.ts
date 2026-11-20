import type { SyncCadence, SyncCadencePreset } from '@tallyui/database';
import { defaultStore, type KeyValueStore } from './session';

export const SYNC_CADENCE_KEY = 'vendurepos.sync.cadence';
// A copy of @tallyui/database's SYNC_CADENCE_PRESETS and SYNC_CADENCE_LIMITS: the web loads that package lazily (#192).
// sync-cadence.test.ts pins both to TallyUI's.
export const CADENCE_PRESETS: Record<SyncCadencePreset, SyncCadence> = {
  eco: { checkIntervalMs: 300000, pullBatchSize: 25 },
  balanced: { checkIntervalMs: 60000, pullBatchSize: 50 },
  realtime: { checkIntervalMs: 10000, pullBatchSize: 75 },
};
export const CADENCE_LIMITS = {
  checkIntervalMs: { min: 5000, max: 300000 }, pullBatchSize: { min: 10, max: 100 },
} as const;
// Vendure's feeds have no push stream, so the till re-pulls on an interval.
// No stored choice is the till's cadence before 10.3i: a re-pull every 60 s, the page size left to the adapter
// (none set for Vendure, so RxDB's 100).
export const STANDARD_CHECK_INTERVAL_MS = 60_000;
export const STANDARD_PAGE_RECORDS = 100;
export type CadenceChoice = 'standard' | SyncCadencePreset | 'custom';
export interface AppSyncCadence { choice: CadenceChoice; checkIntervalMs: number; pullBatchSize?: number }
export const STANDARD_SYNC_CADENCE: AppSyncCadence = { choice: 'standard', checkIntervalMs: STANDARD_CHECK_INTERVAL_MS };
const listeners = new Set<(cadence: AppSyncCadence) => void>();

export function clampCadence(value: SyncCadence): SyncCadence {
  if (!Number.isFinite(value.checkIntervalMs) || !Number.isFinite(value.pullBatchSize)) throw new TypeError('Cadence must contain finite numbers');
  return {
    checkIntervalMs: Math.min(CADENCE_LIMITS.checkIntervalMs.max, Math.max(CADENCE_LIMITS.checkIntervalMs.min, Math.trunc(value.checkIntervalMs))),
    pullBatchSize: Math.min(CADENCE_LIMITS.pullBatchSize.max, Math.max(CADENCE_LIMITS.pullBatchSize.min, Math.trunc(value.pullBatchSize))),
  };
}

export function loadSyncCadence(store: KeyValueStore = defaultStore()): AppSyncCadence {
  try {
    const value = JSON.parse(store.getItem(SYNC_CADENCE_KEY) ?? 'null');
    const preset: unknown = value.preset;
    if (preset === 'eco' || preset === 'balanced' || preset === 'realtime') return { choice: preset, ...CADENCE_PRESETS[preset] };
    if (preset === 'custom') return { choice: 'custom', ...clampCadence(value) };
  } catch { /* An unreadable device preference keeps the standard cadence. */ }
  return STANDARD_SYNC_CADENCE;
}

export function saveSyncCadence(store: KeyValueStore, value: 'standard' | SyncCadencePreset | SyncCadence): AppSyncCadence {
  if (value === 'standard') store.removeItem(SYNC_CADENCE_KEY);
  else if (typeof value === 'string') store.setItem(SYNC_CADENCE_KEY, JSON.stringify({ preset: value }));
  else {
    const cadence = clampCadence(value);
    const preset = (Object.keys(CADENCE_PRESETS) as SyncCadencePreset[]).find(name =>
      CADENCE_PRESETS[name].checkIntervalMs === cadence.checkIntervalMs && CADENCE_PRESETS[name].pullBatchSize === cadence.pullBatchSize);
    store.setItem(SYNC_CADENCE_KEY, JSON.stringify(preset ? { preset } : { preset: 'custom', ...cadence }));
  }
  const cadence = loadSyncCadence(store);
  listeners.forEach(listener => listener(cadence));
  return cadence;
}

export function onSyncCadenceChange(listener: (cadence: AppSyncCadence) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function cadenceSummary(cadence: AppSyncCadence): string {
  const ms = cadence.checkIntervalMs;
  const interval = ms % 60_000 === 0 && ms >= 120_000 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
  return `Every ${interval}, ${cadence.choice === 'standard' ? 'up to ' : ''}${cadence.pullBatchSize ?? STANDARD_PAGE_RECORDS} records a check, ${Math.round(3_600_000 / ms)} checks an hour`;
}
