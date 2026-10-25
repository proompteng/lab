import { defineConfig } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'tengri-playwright-config-'))
const fixtureSecret = path.join(fixtureDirectory, 'oidc-secret')
writeFileSync(fixtureSecret, 'isolated-playwright-client-secret-not-production', { mode: 0o600 })
writeFileSync(path.join(fixtureDirectory, 'TENGRI_INTERNAL_HMAC_SECRET'), '68'.repeat(32), { mode: 0o600 })
process.once('exit', () => rmSync(fixtureDirectory, { recursive: true, force: true }))

const port = Number.parseInt(process.env.TENGRI_PLAYWRIGHT_PORT ?? '3000', 10)
const baseURL = process.env.TENGRI_PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const fixtureCertificate =
  process.env.TENGRI_EDITOR_TEST_HTTPS === '1' ? process.env.TENGRI_EDITOR_TEST_CERT_SPKI : undefined
export default defineConfig({
  testDir: './src/components/tengri',
  testMatch: '**/*.e2e.test.ts',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixels: 250,
    },
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : 2,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    launchOptions: fixtureCertificate
      ? { args: [`--ignore-certificate-errors-spki-list=${fixtureCertificate}`] }
      : undefined,
    colorScheme: 'dark',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    video: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
  },
  webServer:
    process.env.TENGRI_PLAYWRIGHT_SKIP_WEBSERVER === '1'
      ? undefined
      : {
          command: process.env.CI
            ? `bunx next start --hostname 127.0.0.1 --port ${port}`
            : `bunx next dev --turbopack --hostname 127.0.0.1 --port ${port}`,
          cwd: __dirname,
          env: {
            ...process.env,
            TENGRI_DESKTOP_ORIGIN: 'https://proompteng.ai',
            TENGRI_OIDC_CLIENT_SECRET_FILE: fixtureSecret,
            TENGRI_DATABASE_DSN: 'postgres://tengri_bff@localhost:65534/tengri_control',
            TENGRI_DATABASE_PASSWORD_FILE: fixtureSecret,
            TENGRI_DATABASE_CA_FILE: fixtureSecret,
            OFZ_GRPC_ENDPOINT: 'localhost:65535',
            NEXT_TELEMETRY_DISABLED: '1',
            TENGRI_GRPC_ENDPOINT: 'localhost:65535',
            SPIFFE_ENDPOINT_SOCKET: 'unix:///tmp/tengri-playwright-workload-api.sock',
            SPIFFE_ID: 'spiffe://proompteng.ai/ns/proompteng/sa/proompteng',
            TENGRI_SPIFFE_ID: 'spiffe://proompteng.ai/ns/tengri/sa/tengri',
            TENGRI_BFF_SECRET_DIR: fixtureDirectory,
          },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          url: baseURL,
        },
})
