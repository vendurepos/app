import { SYNC_CADENCE_LIMITS, SYNC_CADENCE_PRESETS } from '@tallyui/database';
import { beforeEach, expect, it, vi } from 'vitest';
import type { KeyValueStore } from './session';
import { CADENCE_LIMITS, CADENCE_PRESETS, STANDARD_SYNC_CADENCE, SYNC_CADENCE_KEY, cadenceSummary, clampCadence, loadSyncCadence, onSyncCadenceChange, saveSyncCadence, type AppSyncCadence } from './sync-cadence';

let store: KeyValueStore;
beforeEach(() => {
  const values = new Map<string, string>();
  store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
});

it("copies TallyUI's presets and limits exactly", () => {
  expect(CADENCE_PRESETS).toEqual(SYNC_CADENCE_PRESETS);
  expect(CADENCE_LIMITS).toEqual(SYNC_CADENCE_LIMITS);
});

it('nothing stored keeps the standard cadence: 60 s and no page size', () => {
  expect(loadSyncCadence(store)).toEqual({ choice: 'standard', checkIntervalMs: 60000 });
  expect(loadSyncCadence(store).pullBatchSize).toBeUndefined();
});

it.each(['not json', '{"preset":"turbo"}', '{"preset":"custom","checkIntervalMs":"x","pullBatchSize":50}', '{"preset":"custom"}', 'null'])('an unreadable stored value falls back to standard', value => {
  store.setItem(SYNC_CADENCE_KEY, value);
  expect(loadSyncCadence(store)).toEqual(STANDARD_SYNC_CADENCE);
});

it('saves a preset by name and loads its numbers', () => {
  saveSyncCadence(store, 'eco');
  expect(store.getItem(SYNC_CADENCE_KEY)).toBe('{"preset":"eco"}');
  expect(loadSyncCadence(store)).toEqual({ choice: 'eco', checkIntervalMs: 300000, pullBatchSize: 25 });
});

it('clamps and truncates a custom cadence', () => {
  expect(saveSyncCadence(store, { checkIntervalMs: 1000, pullBatchSize: 500 }))
    .toEqual({ choice: 'custom', checkIntervalMs: 5000, pullBatchSize: 100 });
  expect(saveSyncCadence(store, { checkIntervalMs: 12345.9, pullBatchSize: 33.7 }))
    .toEqual({ choice: 'custom', checkIntervalMs: 12345, pullBatchSize: 33 });
});

it('a custom cadence equal to a preset is stored as that preset', () => {
  expect(saveSyncCadence(store, { checkIntervalMs: 10000, pullBatchSize: 75 }).choice).toBe('realtime');
  expect(store.getItem(SYNC_CADENCE_KEY)).toBe('{"preset":"realtime"}');
});

it('standard removes the stored choice', () => {
  saveSyncCadence(store, 'eco');
  expect(saveSyncCadence(store, 'standard')).toEqual(STANDARD_SYNC_CADENCE);
  expect(store.getItem(SYNC_CADENCE_KEY)).toBeNull();
});

it('tells listeners about a save until they unsubscribe', () => {
  const first = vi.fn(), second = vi.fn();
  const stopFirst = onSyncCadenceChange(first), stopSecond = onSyncCadenceChange(second);
  const eco = saveSyncCadence(store, 'eco');
  expect(first).toHaveBeenCalledExactlyOnceWith(eco);
  expect(second).toHaveBeenCalledExactlyOnceWith(eco);
  stopFirst();
  const standard = saveSyncCadence(store, 'standard');
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenLastCalledWith(standard);
  stopSecond();
  saveSyncCadence(store, 'balanced');
  expect(second).toHaveBeenCalledTimes(2);
});

it('summarises each choice', () => {
  const examples: [AppSyncCadence, string][] = [
    [STANDARD_SYNC_CADENCE, 'Every 60 s, up to 100 records a check, 60 checks an hour'],
    [{ choice: 'eco', ...CADENCE_PRESETS.eco }, 'Every 5 min, 25 records a check, 12 checks an hour'],
    [{ choice: 'balanced', ...CADENCE_PRESETS.balanced }, 'Every 60 s, 50 records a check, 60 checks an hour'],
    [{ choice: 'realtime', ...CADENCE_PRESETS.realtime }, 'Every 10 s, 75 records a check, 360 checks an hour'],
    [{ choice: 'custom', checkIntervalMs: 5000, pullBatchSize: 100 }, 'Every 5 s, 100 records a check, 720 checks an hour'],
  ];
  for (const [cadence, summary] of examples) expect(cadenceSummary(cadence)).toBe(summary);
});

it('refuses a non-finite custom number', () => {
  expect(() => clampCadence({ checkIntervalMs: NaN, pullBatchSize: 50 })).toThrow(TypeError);
});
