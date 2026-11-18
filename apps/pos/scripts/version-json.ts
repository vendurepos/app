import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
// /version.json for the marketing site's Changelog: app.json version, Vercel's commit (null locally), build time.
export function versionJson(appVersion: string, env: Record<string, string | undefined>, now: Date) {
  return { version: appVersion, commit: env.VERCEL_GIT_COMMIT_SHA || null, builtAt: now.toISOString() };
}
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  const json = versionJson(version, process.env, new Date());
  writeFileSync(`${process.argv[2]}/version.json`, JSON.stringify(json, null, 2) + '\n');
  console.log(`version.json: ${json.version} ${json.commit ?? '(no commit)'} ${json.builtAt}`);
}
