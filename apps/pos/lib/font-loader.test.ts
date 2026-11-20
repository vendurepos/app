import { expect, it, vi } from 'vitest';
import { createFontLoader, type FontLoaderDeps } from './font-loader';

const faces: FontLoaderDeps['faces'] = {
  'DM Sans': [{ weight: 700, asset: 'dm700' }, { weight: 400, asset: 'dm400' }],
  'Instrument Serif': [
    { weight: 400, style: 'italic', asset: 'serifItalic' },
    { weight: 400, asset: 'serif400' },
  ],
};
const families = ['DM Sans', 'Instrument Serif'] as const;

it('web adds every requested face in parallel exactly once', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const addWebFace = vi.fn(() => pending);
  const loadNative = vi.fn();
  const load = createFontLoader({ faces, web: true, addWebFace, loadNative });
  const loading = load(families);
  expect(addWebFace.mock.calls).toEqual(families.flatMap((family) => faces[family]!.map((face) => [family, face])));
  release();
  await loading;
  expect(loadNative).not.toHaveBeenCalled();
});

it('web adds nothing on a second call for loaded families', async () => {
  const addWebFace = vi.fn(async () => {});
  const load = createFontLoader({ faces, web: true, addWebFace, loadNative: vi.fn() });
  await load(families);
  addWebFace.mockClear();
  await load(families);
  expect(addWebFace).not.toHaveBeenCalled();
});

it('web rejects a failed face and later retries only that face', async () => {
  const error = new Error('face failed');
  const addWebFace = vi.fn<FontLoaderDeps['addWebFace']>().mockResolvedValue(undefined).mockRejectedValueOnce(error);
  const load = createFontLoader({ faces, web: true, addWebFace, loadNative: vi.fn() });
  await expect(load(families)).rejects.toBe(error);
  expect(addWebFace).toHaveBeenCalledTimes(4);
  addWebFace.mockClear();
  await load(families);
  expect(addWebFace.mock.calls).toEqual([['DM Sans', faces['DM Sans']![0]]]);
});

it('native loads the lowest non-italic face per family in one call', async () => {
  const loadNative = vi.fn(async () => {});
  const addWebFace = vi.fn();
  const load = createFontLoader({ faces, web: false, addWebFace, loadNative });
  await load(families);
  expect(loadNative.mock.calls).toEqual([[{ 'DM Sans': 'dm400', 'Instrument Serif': 'serif400' }]]);
  await load(families);
  expect(loadNative).toHaveBeenCalledTimes(1);
  expect(addWebFace).not.toHaveBeenCalled();
});

it.each([true, false])('rejects a missing family (web=%s)', async (web) => {
  const load = createFontLoader({ faces, web, addWebFace: vi.fn(), loadNative: vi.fn() });
  await expect(load(['Manrope'])).rejects.toThrow('No bundled faces for Manrope');
});
