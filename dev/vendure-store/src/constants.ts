// The dev store does not report telemetry.
process.env.VENDURE_DISABLE_TELEMETRY ??= 'true';

// Dev-only: the store binds to 127.0.0.1 and holds no real data.
export const SUPERADMIN_USERNAME = 'superadmin';
// Dev-only: the store binds to 127.0.0.1 and holds no real data.
export const SUPERADMIN_PASSWORD = 'superadmin';
// Cookie signing secret for the local dev store.
export const COOKIE_SECRET = 'vendurepos-dev-cookie-secret';
// Stable token for the default channel.
export const DEFAULT_CHANNEL_TOKEN = 'vendurepos-dev-default';
// Code of the POS channel the seed creates.
export const POS_CHANNEL_CODE = 'pos';
// vendure-token header value that selects the POS channel.
export const POS_CHANNEL_TOKEN = 'vendurepos-dev-pos';
// Loopback only, per ADR-058.
export const SERVER_HOST = '127.0.0.1';
// Postgres is reachable only on loopback.
export const DB_HOST = '127.0.0.1';
// Local Postgres username.
export const DB_USERNAME = 'vendure';
// Local Postgres password.
export const DB_PASSWORD = 'vendure';
// Local Postgres database name.
export const DB_NAME = 'vendure';
// Override the API port when another local server occupies port 3000.
export const SERVER_PORT = Number(process.env.VENDURE_PORT ?? 3000);
// Override the Postgres port; port 5432 is used by the host Postgres.
export const DB_PORT = Number(process.env.VENDURE_DB_PORT ?? 5442);
// Expo dev server and e2e web export origins.
export const CORS_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:8099',
  'http://127.0.0.1:8099',
];
