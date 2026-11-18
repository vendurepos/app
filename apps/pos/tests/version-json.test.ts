import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const root = mkdtempSync(`${tmpdir()}/version-json-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function build(sha?: string) {
  const dir = mkdtempSync(`${root}/build-`);
  const env = { ...process.env, VERCEL_GIT_COMMIT_SHA: sha };
  if (sha === undefined) delete env.VERCEL_GIT_COMMIT_SHA;
  const before = new Date();
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/version-json.ts', import.meta.url)), dir], { env });
  const json = JSON.parse(readFileSync(`${dir}/version.json`, 'utf8'));
  expect(Object.keys(json)).toEqual(['version', 'commit', 'builtAt']);
  expect(json.version).toBe(read('app.json').expo.version);
  expect(new Date(json.builtAt).toISOString()).toBe(json.builtAt);
  expect(before <= new Date(json.builtAt) && new Date(json.builtAt) <= new Date()).toBe(true);
  return json;
}
describe('version.json', () => {
  it('is emitted with the commit', () => expect(build('0123456789abcdef0123456789abcdef01234567').commit).toBe('0123456789abcdef0123456789abcdef01234567'));
  it('has a null commit on a local build', () => expect(build().commit).toBeNull());
  it('is written by build:web before the bundle check', () => expect(read('package.json').scripts['build:web']).toMatch(/&& node scripts\/version-json\.ts dist && .*check-web-bundle\.sh/));
});
