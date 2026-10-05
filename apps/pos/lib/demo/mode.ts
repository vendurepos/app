// The demo build (pnpm build:web:demo, VA9). Expo inlines EXPO_PUBLIC_* at build time only for this literal
// `process.env.EXPO_PUBLIC_…` access, so a normal build carries `false` here and never the demo. Metro's transform
// cache ($TMPDIR/metro-cache) is not keyed by the variable's value, so build:web:demo keeps its own TMPDIR: sharing the
// cache, a normal build after a demo build would reuse this file's demo transform and come out a demo.
export const DEMO_MODE = process.env.EXPO_PUBLIC_VENDUREPOS_DEMO === '1';
