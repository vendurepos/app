import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const meta = html.match(/<meta\s[^>]*?http-equiv="Content-Security-Policy"[^>]*?\scontent="([^"]*)"/i);
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
  cleanUrls?: boolean;
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const policy = config.headers.find(({ source }) => source === '/(.*)')?.headers
  .find(({ key }) => key === 'Content-Security-Policy')?.value;

describe('Vercel Content-Security-Policy', () => {
  it('serves the meta policy plus frame-ancestors on every path, including the SQLite worker', () => {
    expect(meta).not.toBeNull();
    expect(policy).toBe(`${meta?.[1]}; frame-ancestors 'none'`);
  });

  it('permits WebAssembly compilation without JavaScript eval', () => {
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('does not enable cleanUrls for the SPA export', () => {
    expect(config.cleanUrls).not.toBe(true);
  });

  it('caches only the content-hashed Expo bundles as immutable', () => {
    const immutable = config.headers.find(({ source }) => source === '/_expo/static/(.*)');
    expect(immutable?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ]);
    expect(config.headers.filter(({ headers }) =>
      headers.some(({ key }) => key.toLowerCase() === 'cache-control'),
    )).toEqual([immutable]);
    const root = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/i);
    expect(root).not.toBeNull();
    expect(root?.[1]).toContain('class="boot-splash"');
    expect(root?.[1]).not.toMatch(/<script/i);
  });
});
