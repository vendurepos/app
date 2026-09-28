import { describe, expect, it } from 'vitest';
import { normalizeStoreUrl } from './store-url';

describe('normalizeStoreUrl', () => {
  it.each([
    ['https://shop.example.com/', 'https://shop.example.com'],
    ['https://shop.example.com/admin-api/', 'https://shop.example.com'],
    ['https://example.com/vendure/admin-api', 'https://example.com/vendure'],
    ['http://127.0.0.1:3200', 'http://127.0.0.1:3200'],
    ['  https://SHOP.example.com/vendure/admin-api///?q=1#top  ', 'https://shop.example.com/vendure'],
    ['https://example.com/vendure///admin-api/', 'https://example.com/vendure'],
    ['https://example.com/admin-api/admin-api', 'https://example.com/admin-api'],
    ['https://example.com/admin-api-extra/', 'https://example.com/admin-api-extra'],
  ])('normalizes %s', (input, url) => {
    expect(normalizeStoreUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    'localhost', 'pos.localhost', '127.255.0.2', '[::1]', '10.0.0.1',
    '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.1.20', 'foo.local',
  ])('allows HTTP for %s', (host) => {
    expect(normalizeStoreUrl(`http://${host}`)).toEqual({ ok: true, url: `http://${host}` });
  });

  it.each([
    'shop.example.com', '172.32.0.1', '10.example.com', '172.15.255.255',
    '192.169.1.20', '126.255.255.255', '128.0.0.1', '8.8.8.8',
    'localhost.example.com', 'foo.local.example.com', '[2001:db8::1]',
  ])('refuses HTTP for %s', (host) => {
    expect(normalizeStoreUrl(`http://${host}`)).toEqual({
      ok: false,
      error: 'Use https:// for this server. Plain http:// is only allowed for local and private network addresses.',
    });
  });

  it.each(['ftp://x', 'shop.example.com', 'https://', 'http://10.256.0.1'])('refuses %s', (input) => {
    expect(normalizeStoreUrl(input)).toEqual({
      ok: false, error: 'Enter the full server URL, starting with https://.',
    });
  });

  it.each(['', '   '])('requires a URL for %j', (input) => {
    expect(normalizeStoreUrl(input)).toEqual({ ok: false, error: 'Enter your Vendure server URL.' });
  });
});
