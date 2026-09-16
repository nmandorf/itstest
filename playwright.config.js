import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],

  webServer: {
    command: 'npx http-server . -a 127.0.0.1 -p 4173 -c-1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
