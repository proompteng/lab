import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? process.env.JANGAR_PORT ?? '3000', 10)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const configDir = dirname(fileURLToPath(import.meta.url))
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === '1'
const useNodeVite = process.env.PLAYWRIGHT_NODE_VITE === '1'
const webServerCommand = useNodeVite
  ? `./node_modules/.bin/vite dev --host --port ${port}`
  : `bun --bun vite dev --host --port ${port}`
const webServerEnv = {
  ...(useNodeVite ? { JANGAR_BUN_SHIM: '1' } : {}),
  JANGAR_SKIP_MIGRATIONS: '1',
  ...(process.env.DATABASE_URL ? {} : { DATABASE_URL: 'postgres://localhost:5432/jangar' }),
}

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
  webServer: skipWebServer
    ? undefined
    : {
        command: webServerCommand,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        cwd: configDir,
        env: webServerEnv,
      },
})
