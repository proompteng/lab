import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const port = Number.parseInt(process.env.JANGAR_PORT ?? '3000', 10)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.ts'],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `bun --bun vite dev --host --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: configDir,
  },
})
