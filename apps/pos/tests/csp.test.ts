import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it, expect } from 'vitest';

// public/index.html is the web export's template; its CSP meta protects the session token in localStorage.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
const directives = new Map(
  (meta?.[1] ?? '').split(';').map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name).map(([name, ...sources]) => [name, sources]),
);

describe('Content-Security-Policy meta', () => {
  it('is in the web template', () => {
    expect(meta).not.toBeNull();
  });

  it('never allows inline or eval script', () => {
    expect(directives.get('script-src')).toBeDefined();
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('blocks plugins and <base>', () => {
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
  });

  it('lets the app reach any HTTPS store and a loopback dev store', () => {
    expect(directives.get('connect-src')).toEqual(expect.arrayContaining(['https:', 'http://127.0.0.1:*']));
  });
});
