import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The public demo's origin (Vercel project vendurepos-demo); the demo build only.
export const DEMO_SITE_ORIGIN = 'https://demo.vendurepos.com';
// The marketing site's share card (vendurepos.com's Next.js opengraph-image), reused rather than copied.
export const SHARE_IMAGE = 'https://vendurepos.com/opengraph-image';
export const DEMO_TITLE = 'VendurePOS demo: try the point of sale for Vendure';
export const DEMO_DESCRIPTION =
  'Try VendurePOS in the browser: a sample Vendure store with one-click sign-in. Sell, run a register day, and reset it whenever you like. Nothing to install.';

export const SHARE_TAGS = `    <link rel="canonical" href="${DEMO_SITE_ORIGIN}/demo" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="VendurePOS" />
    <meta property="og:url" content="${DEMO_SITE_ORIGIN}/demo" />
    <meta property="og:title" content="${DEMO_TITLE}" />
    <meta property="og:description" content="${DEMO_DESCRIPTION}" />
    <meta property="og:image" content="${SHARE_IMAGE}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="VendurePOS: point of sale for Vendure" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${DEMO_TITLE}" />
    <meta name="twitter:description" content="${DEMO_DESCRIPTION}" />
    <meta name="twitter:image" content="${SHARE_IMAGE}" />
`;

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${DEMO_SITE_ORIGIN}/</loc></url>
  <url><loc>${DEMO_SITE_ORIGIN}/demo</loc></url>
</urlset>
`;

export const ROBOTS_TXT = `# VendurePOS demo: indexing allowed (the public demo at /demo is meant to be found).
User-agent: *
Allow: /

Sitemap: ${DEMO_SITE_ORIGIN}/sitemap.xml
`;

export function addShareTags(html: string): string {
  const heads = html.split('</head>').length - 1;
  if (heads !== 1) throw new Error(`Expected one </head>, found ${heads}`);
  if (html.includes('property="og:') || html.includes('rel="canonical"')) {
    throw new Error('index.html already has share tags');
  }
  return html.replace('</head>', `${SHARE_TAGS}</head>`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.EXPO_PUBLIC_VENDUREPOS_DEMO === '1') {
  const dist = process.argv[2];
  const file = join(dist, 'index.html');
  writeFileSync(file, addShareTags(readFileSync(file, 'utf8')));
  writeFileSync(join(dist, 'sitemap.xml'), SITEMAP_XML);
  writeFileSync(join(dist, 'robots.txt'), ROBOTS_TXT);
  console.log('Demo: share tags, canonical, sitemap.xml and robots.txt Sitemap line (EXPO_PUBLIC_VENDUREPOS_DEMO=1)');
}
