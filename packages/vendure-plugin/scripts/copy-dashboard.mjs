// Dashboard Vite builds need the extension source next to the compiled plugin in the published package.
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
fs.rmSync(new URL('dist/dashboard', root), { recursive: true, force: true });
fs.cpSync(new URL('src/dashboard', root), new URL('dist/dashboard', root), { recursive: true });
