import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { allowLanHttp } from '../scripts/csp-lan-http';

// public/index.html is the web export's template; scripts/csp-lan-http.ts loosens its connect-src and img-src only when asked.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const metaTag = html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/)?.[0] ?? '';

// Directive name -> its raw text between semicolons, so a comparison is byte for byte.
function directives(page: string) {
  const content = page.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1];
  if (content === undefined) throw new Error('no Content-Security-Policy meta');
  return new Map(content.split(';').map((directive) => [directive.trim().split(/\s+/)[0], directive] as const));
}

function sources(directive: string | undefined) {
  return (directive ?? '').trim().split(/\s+/).slice(1);
}

describe('allowLanHttp', () => {
  const before = directives(html);
  const after = directives(allowLanHttp(html));

  it('the default connect-src does not allow plain http beyond loopback', () => {
    expect(before.get('connect-src')).toBeDefined();
    expect(sources(before.get('connect-src'))).not.toContain('http:');
  });

  it('the default img-src does not allow plain http', () => {
    expect(before.get('img-src')).toBeDefined();
    expect(sources(before.get('img-src'))).not.toContain('http:');
  });

  it('adds http: to connect-src and keeps every original source', () => {
    expect(sources(after.get('connect-src'))).toEqual([...sources(before.get('connect-src')), 'http:']);
  });

  it('adds http: to img-src and keeps every original source', () => {
    expect(sources(after.get('img-src'))).toEqual([...sources(before.get('img-src')), 'http:']);
  });

  it('leaves every other directive byte-identical', () => {
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, directive] of before) {
      if (name !== 'connect-src' && name !== 'img-src') expect(after.get(name)).toBe(directive);
    }
  });

  it('changes nothing in the html outside connect-src and img-src', () => {
    expect(allowLanHttp(html).replaceAll(' http:;', ';')).toBe(html);
  });

  it('applying it twice equals applying it once', () => {
    expect(allowLanHttp(allowLanHttp(html))).toBe(allowLanHttp(html));
  });

  it('throws on html with no CSP meta', () => {
    expect(() => allowLanHttp(html.replace(metaTag, ''))).toThrow(Error);
  });

  it('throws on html with two CSP metas', () => {
    expect(metaTag).not.toBe('');
    expect(() => allowLanHttp(html.replace('</head>', `${metaTag}\n</head>`))).toThrow(Error);
  });

  it('throws when the CSP meta has no connect-src', () => {
    const connectSrc = before.get('connect-src') ?? '';
    expect(() => allowLanHttp(html.replace(`${connectSrc};`, ''))).toThrow(Error);
  });

  it('throws when the CSP meta has no img-src', () => {
    const imgSrc = before.get('img-src') ?? '';
    expect(() => allowLanHttp(html.replace(`${imgSrc};`, ''))).toThrow(Error);
  });
});
