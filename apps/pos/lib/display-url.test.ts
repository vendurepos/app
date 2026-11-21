import { expect, it } from 'vitest';
import { displayPageUrl } from './display-url';

it('points at /display on the origin with the store URL encoded', () => {
  expect(displayPageUrl('https://app.example.com', 'https://store.example.com/'))
    .toBe('https://app.example.com/display?store=https%3A%2F%2Fstore.example.com%2F');
});

it('trims a trailing slash from the origin', () => {
  expect(displayPageUrl('https://app.example.com/', 'https://s.example')).toBe('https://app.example.com/display?store=https%3A%2F%2Fs.example');
});

it('encodes a store URL with a path or query once, not twice', () => {
  const url = displayPageUrl('https://app.example.com', 'https://s.example/shop-api?a=1&b=%20');
  expect(url).toBe('https://app.example.com/display?store=https%3A%2F%2Fs.example%2Fshop-api%3Fa%3D1%26b%3D%2520');
  expect(new URL(url).searchParams.get('store')).toBe('https://s.example/shop-api?a=1&b=%20');
});
