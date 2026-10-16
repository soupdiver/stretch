import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  workers: 1,
  use: { browserName: 'chromium', headless: true },
  webServer: { command: 'node tests/server.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
  metadata: { extensionPath: resolve('dist') }
});
