// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { coveredByDialog } from './print-cover';

it.each([
  ['no dialog', '<span data-marker></span>', false],
  ['a containing dialog', '<div role="dialog"><span data-marker></span></div>', false],
  ['a dialog elsewhere', '<span data-marker></span><div role="dialog"></div>', true],
  ['a containing dialog plus one elsewhere', '<div role="dialog"><span data-marker></span></div><div role="dialog"></div>', true],
] as const)('%s', (_name, html, covered) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  const node = root.querySelector('[data-marker]')!;
  expect(coveredByDialog(node, root)).toBe(covered);
});
