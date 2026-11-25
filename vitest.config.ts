import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@uelights/shared': path.resolve(__dirname, 'packages/shared/src/index.ts') },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'server/test/**/*.test.ts'],
  },
});
