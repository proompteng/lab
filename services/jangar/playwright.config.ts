import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? process.env.JANGAR_PORT ?? '3000', 10)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.e2e.ts', '**/*.spec.ts'],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  workers: 1,
  webServer: {
    command: `bun --bun vite dev --host --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: configDir,
  },
})
