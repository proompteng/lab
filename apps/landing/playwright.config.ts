import { defineConfig } from '@playwright/test'

const port = Number.parseInt(process.env.TENGRI_PLAYWRIGHT_PORT ?? '3000', 10)
const baseURL = process.env.TENGRI_PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const configDir = __dirname

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
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
          cwd: configDir,
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          url: baseURL,
        },
})
