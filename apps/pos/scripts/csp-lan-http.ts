import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set to 1 at build time only for a web export served over plain http on the same LAN as a plain-http store.
export const LAN_HTTP_ENV = 'VENDUREPOS_WEB_ALLOW_LAN_HTTP';

const CSP_META = /<meta\s[^>]*?http-equiv="Content-Security-Policy"[^>]*?\scontent="([^"]*)"/gi;

// Appends ` http:` to the CSP meta's connect-src and changes nothing else.
export function allowLanHttp(html: string): string {
  const metas = [...html.matchAll(CSP_META)];
  if (metas.length !== 1) throw new Error(`Expected one Content-Security-Policy meta, found ${metas.length}`);
  const [whole, policy] = metas[0];
  const directives = policy.split(';');
  const index = directives.findIndex((directive) => directive.trim().split(/\s+/)[0] === 'connect-src');
  if (index === -1) throw new Error('The Content-Security-Policy meta has no connect-src');
  if (directives[index].trim().split(/\s+/).includes('http:')) return html;
  directives[index] = directives[index].replace(/\S(?=\s*$)/, '$& http:');
  // The match ends with the content attribute's closing quote.
  const policyEnd = metas[0].index + whole.length - 1;
  return html.slice(0, policyEnd - policy.length) + directives.join(';') + html.slice(policyEnd);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.env[LAN_HTTP_ENV] === '1') {
  const file = join(process.argv[2], 'index.html');
  writeFileSync(file, allowLanHttp(readFileSync(file, 'utf8')));
  console.log(`CSP: connect-src allows http: (${LAN_HTTP_ENV}=1)`);
}
