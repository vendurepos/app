import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

// pnpm e2e (scripts/e2e.sh) serves the web export as its host will: index.html's CSP meta, plus the frame-ancestors a
// meta cannot set, as a response header on the HTML document. Only there: a worker script takes the CSP of its own
// response, and this policy's script-src (no 'wasm-unsafe-eval') stops the SQLite worker compiling its wasm. VA8's
// hosting config must scope the header the same way.
// Usage: node scripts/serve-web.ts <dist> <port>
const dist = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 8099);

// The same match as scripts/csp-lan-http.ts.
const CSP_META = /<meta\s[^>]*?http-equiv="Content-Security-Policy"[^>]*?\scontent="([^"]*)"/i;
const policy = CSP_META.exec(readFileSync(join(dist, 'index.html'), 'utf8'))?.[1];
if (!policy) throw new Error(`${dist}/index.html has no Content-Security-Policy meta`);
const CSP = `${policy}; frame-ancestors 'none'`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  let file = resolve(dist, `.${path}`);
  // A route with no file is the single-page app's (the host's rewrite); a missing asset is a 404.
  if (!file.startsWith(dist + sep) || !isFile(file)) file = extname(path) ? '' : join(dist, 'index.html');
  if (!file) {
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not Found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store', 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    ...(extname(file) === '.html' ? { 'Content-Security-Policy': CSP } : {}),
  });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`serve-web: ${dist} on http://127.0.0.1:${port}`));
