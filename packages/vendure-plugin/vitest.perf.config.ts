import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Opt-in perf fixtures, never run by npm test or CI.
export default defineConfig({
  plugins: [swc.vite({
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  })],
  test: {
    include: ['test/perf/**/*.perf.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
