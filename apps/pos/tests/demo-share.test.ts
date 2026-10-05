import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { addShareTags, SHARE_TAGS, SITEMAP_XML, ROBOTS_TXT } from '../scripts/demo-share';

const template = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

describe('demo share metadata', () => {
  it('the template carries no share tags, so a normal build has none', () => {
    expect(template).not.toContain('property="og:');
    expect(template).not.toContain('name="twitter:');
    expect(template).not.toContain('rel="canonical"');
    expect(readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')).not.toContain('Sitemap:');
  });

  it('addShareTags inserts every tag once, inside head, and changes nothing else', () => {
    const html = addShareTags(template);
    for (const line of SHARE_TAGS.split('\n').slice(0, -1)) {
      expect(html.split(line)).toHaveLength(2);
    }
    expect(html.indexOf(SHARE_TAGS)).toBeGreaterThan(html.indexOf('<head>'));
    expect(html).toContain(`${SHARE_TAGS}</head>`);
    expect(html.replace(SHARE_TAGS, '')).toBe(template);
    expect(html).toContain('<link rel="canonical" href="https://demo.vendurepos.com/demo" />');
    expect(html).toContain('<meta property="og:url" content="https://demo.vendurepos.com/demo" />');
    expect(html).toContain('<meta property="og:image" content="https://vendurepos.com/opengraph-image" />');
    expect(html).toContain('<meta name="twitter:image" content="https://vendurepos.com/opengraph-image" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('addShareTags refuses html without one </head> or with tags already', () => {
    expect(() => addShareTags('<html></html>')).toThrow('Expected one </head>, found 0');
    expect(() => addShareTags('<head></head></head>')).toThrow('Expected one </head>, found 2');
    expect(() => addShareTags(addShareTags(template))).toThrow('index.html already has share tags');
    expect(() => addShareTags('<head><meta property="og:type" content="website" /></head>'))
      .toThrow('index.html already has share tags');
    expect(() => addShareTags('<head><link rel="canonical" href="/" /></head>'))
      .toThrow('index.html already has share tags');
  });

  it('the sitemap lists / and /demo on the demo origin', () => {
    expect([...SITEMAP_XML.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1])).toEqual([
      'https://demo.vendurepos.com/',
      'https://demo.vendurepos.com/demo',
    ]);
    expect(SITEMAP_XML.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('the demo robots.txt allows indexing and names the sitemap', () => {
    const lines = ROBOTS_TXT.split('\n');
    expect(lines).toContain('User-agent: *');
    expect(lines).toContain('Allow: /');
    expect(lines).toContain('Sitemap: https://demo.vendurepos.com/sitemap.xml');
  });
});
