import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './smoke',
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  outputDir: '.test-data/playwright-results',
});
