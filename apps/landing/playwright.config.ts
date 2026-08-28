import { defineConfig } from '@playwright/test'

const port = Number.parseInt(process.env.TENGRI_PLAYWRIGHT_PORT ?? '3000', 10)
const baseURL = process.env.TENGRI_PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './src/components/tengri',
  testMatch: '**/*.e2e.test.ts',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    colorScheme: 'dark',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer:
    process.env.TENGRI_PLAYWRIGHT_SKIP_WEBSERVER === '1'
      ? undefined
      : {
          command: `bunx next dev --turbopack --hostname 127.0.0.1 --port ${port}`,
          cwd: __dirname,
          env: {
            ...process.env,
            BETTER_AUTH_SECRET: 'playwright-better-auth-secret-000000000000',
            BETTER_AUTH_URL: baseURL,
            GITHUB_CLIENT_ID: 'playwright',
            GITHUB_CLIENT_SECRET: 'playwright',
            NEXT_TELEMETRY_DISABLED: '1',
            TENGRI_GRPC_ENDPOINT: '127.0.0.1:65535',
            TENGRI_INTERNAL_HMAC_SECRET: 'playwright-tengri-hmac-secret-0000000000',
          },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          url: baseURL,
        },
})
