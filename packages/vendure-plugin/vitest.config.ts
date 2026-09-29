import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  })],
  test: {
    include: ['test/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
