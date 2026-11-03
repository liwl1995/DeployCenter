import { defineConfig } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  resolve: { alias: [{ find: /^\.\/demo$/, replacement: path.resolve('src/production-data.ts') }] },
  plugins: [react()],
  define: { __PROTOTYPE__: 'false' },
  build: { target: 'chrome140', outDir: 'dist', sourcemap: true },
  server: { host: '127.0.0.1', strictPort: true },
});
