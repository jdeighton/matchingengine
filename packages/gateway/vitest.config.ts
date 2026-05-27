import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname equivalent: directory containing this config file
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// root = packages/gateway → packages → monorepo root
const root = resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@matchingengine/engine': resolve(root, 'packages/engine/src/index.ts'),
      '@matchingengine/shared-types': resolve(root, 'packages/shared-types/src/index.ts'),
    },
  },
  test: {
    globals: false,
  },
});
