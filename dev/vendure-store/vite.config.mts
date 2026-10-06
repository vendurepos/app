// Build the dev store's Dashboard; the server serves dist/dashboard at /dashboard.
import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/dashboard',
  build: { outDir: join(__dirname, 'dist/dashboard') },
  plugins: [vendureDashboardPlugin({
    vendureConfigPath: pathToFileURL('./src/vendure-config.ts'),
    api: { host: 'http://localhost', port: Number(process.env.VENDURE_PORT || 3000) },
    gqlOutputPath: './src/gql',
  })],
  resolve: { alias: { '@/gql': resolve(__dirname, './src/gql/graphql.ts') } },
});
