import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createVendureConnector } from '@tallyui/connector-vendure';
import { describe, it, expect } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const tallyuiDependencies = [
  ...Object.entries(packageJson.dependencies),
  ...Object.entries(packageJson.devDependencies),
].filter(([name]) => name.startsWith('@tallyui/'));

// An exact published version: a release, or a numbered prerelease on a TallyUI dist-tag (e.g. 3.0.0-next.0 on `next`).
const EXACT_VERSION = /^\d+\.\d+\.\d+(-(alpha|beta|rc|next)\.\d+)?$/;

describe('TallyUI dependencies', () => {
  it('Every @tallyui/* dependency is an exact published version', () => {
    expect(tallyuiDependencies.length).toBeGreaterThan(0);
    expect(tallyuiDependencies.map(([name]) => name)).toContain(
      '@tallyui/connector-vendure',
    );
    for (const [, version] of tallyuiDependencies) {
      expect(version).toMatch(EXACT_VERSION);
    }
  });

  it('The exact-version shape refuses unnumbered prereleases and ranges', () => {
    for (const version of ['3.0.0-next', '3.0.0-rc', '^3.0.0-next.0']) {
      expect(version).not.toMatch(EXACT_VERSION);
    }
  });

  it('All @tallyui/* packages share one version', () => {
    expect(new Set(tallyuiDependencies.map(([, version]) => version)).size).toBe(1);
  });

  it('No root override points @tallyui/* elsewhere', () => {
    const rootPackageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    );
    const overrides = Object.keys(rootPackageJson.pnpm?.overrides ?? {});
    expect(overrides.some((name) => name.startsWith('@tallyui/'))).toBe(false);
  });

  it('The published Vendure connector resolves', () => {
    expect(createVendureConnector({ pricesIncludeTax: true }).id).toBe('vendure');
  });
});
