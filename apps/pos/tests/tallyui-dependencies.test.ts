import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { vendureConnector } from '@tallyui/connector-vendure';
import { describe, it, expect } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const tallyuiDependencies = [
  ...Object.entries(packageJson.dependencies),
  ...Object.entries(packageJson.devDependencies),
].filter(([name]) => name.startsWith('@tallyui/'));

describe('TallyUI dependencies', () => {
  it('Every @tallyui/* dependency is an exact published version', () => {
    expect(tallyuiDependencies.length).toBeGreaterThan(0);
    expect(tallyuiDependencies.map(([name]) => name)).toContain(
      '@tallyui/connector-vendure',
    );
    for (const [, version] of tallyuiDependencies) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
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
    expect(vendureConnector.id).toBe('vendure');
  });
});
