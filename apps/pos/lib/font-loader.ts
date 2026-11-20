import type { ThemeFontFamily } from '@tallyui/theme';

export type FontFaceSource = { weight: number; style?: 'italic'; asset: unknown };
export interface FontLoaderDeps {
  faces: Readonly<Partial<Record<ThemeFontFamily, readonly FontFaceSource[]>>>;
  web: boolean;
  addWebFace: (family: ThemeFontFamily, face: FontFaceSource) => Promise<void>;
  loadNative: (fonts: Record<string, unknown>) => Promise<void>;
}
export function createFontLoader(deps: FontLoaderDeps): (families: readonly ThemeFontFamily[]) => Promise<void> {
  const loaded = new Set<string>();
  return async (families) => {
    const requested = families.map((family) => {
      const faces = deps.faces[family];
      if (!faces?.length) throw new Error(`No bundled faces for ${family}`);
      return { family, faces };
    });
    if (deps.web) {
      await Promise.all(requested.flatMap(({ family, faces }) => faces.map(async (face) => {
        const key = `${family}|${face.weight}|${face.style ?? 'normal'}`;
        if (loaded.has(key)) return;
        await deps.addWebFace(family, face);
        loaded.add(key);
      })));
    } else {
      const fonts: Record<string, unknown> = {};
      for (const { family, faces } of requested) {
        if (loaded.has(family)) continue;
        fonts[family] = faces.filter((face) => !face.style).sort((a, b) => a.weight - b.weight)[0].asset;
      }
      if (!Object.keys(fonts).length) return;
      await deps.loadNative(fonts);
      for (const family of Object.keys(fonts)) loaded.add(family);
    }
  };
}
