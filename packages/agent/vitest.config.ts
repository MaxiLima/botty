import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@botty/shared/migrations-dir',
        replacement: path.resolve(here, '../shared/src/migrations.ts'),
      },
      { find: '@botty/shared', replacement: path.resolve(here, '../shared/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
