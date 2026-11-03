import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
export default defineConfig({
  plugins: [
    {
      name: 'shell-as-text',
      load(id) {
        if (id.endsWith('.sh'))
          return 'export default ' + JSON.stringify(fs.readFileSync(id, 'utf8'));
      },
    },
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    exclude: ['**/node_modules/**', '**/dist/**', 'smoke/**'],
  },
});
