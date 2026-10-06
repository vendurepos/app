import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageDir = join(__dirname, '..');
const sourceFile = join(packageDir, 'src/dashboard/index.tsx');

describe('the Dashboard extension is packaged where the Dashboard looks for it', () => {
  it('copies the extension source byte-for-byte to dist/dashboard/index.tsx', () => {
    const builtFile = join(packageDir, 'dist/dashboard/index.tsx');
    expect(existsSync(builtFile)).toBe(true);
    expect(readFileSync(builtFile)).toEqual(readFileSync(sourceFile));
  });

  it('declares the Dashboard path as a literal in the compiled plugin decorator', () => {
    const plugin = readFileSync(join(packageDir, 'dist/plugin.js'), 'utf8');
    expect(plugin).toMatch(/dashboard:\s*(['"])\.\/dashboard\/index\.tsx\1/);
  });

  it('includes the extension in the published package', () => {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageDir, encoding: 'utf8',
    })) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0].files.map(file => file.path)).toContain('dist/dashboard/index.tsx');
  });

  it('imports only modules available to a published Dashboard extension', () => {
    const source = readFileSync(sourceFile, 'utf8');
    const imports = [...source.matchAll(/\bimport\s+[\s\S]*?\s+from\s+(['"])([^'"]+)\1/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const match of imports) expect(['@vendure/dashboard', 'react']).toContain(match[2]);
  });

  it('targets the stock API keys page and the till role and key mutations', () => {
    const source = readFileSync(sourceFile, 'utf8');
    expect(source).toMatch(/pageId:\s*(['"])api-key-list\1/);
    expect(source).toContain('tallyEnsurePosTillRole');
    expect(source).toContain('createApiKey');
  });
});
