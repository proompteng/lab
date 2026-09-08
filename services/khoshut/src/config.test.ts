import { afterEach, describe, expect, it } from 'bun:test'
import { loadConfig } from './config'

const ENV_KEYS = [
  'HOST',
  'PORT',
  'INNGEST_APP_ID',
  'INNGEST_BASE_URL',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'INNGEST_STARTUP_TIMEOUT_MS',
  'INNGEST_STARTUP_CHECK_INTERVAL_MS',
  'INNGEST_STARTUP_REQUEST_TIMEOUT_MS',
] as const
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  string,
  string | undefined
>

const resetEnv = () => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
}

describe('loadConfig', () => {
  afterEach(() => {
    resetEnv()
  })

  it('requires inngest keys', () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }

    expect(() => loadConfig()).toThrow('INNGEST_EVENT_KEY is required')
  })

  it('loads valid config when required values are provided', () => {
    process.env.INNGEST_EVENT_KEY = '0123456789abcdef0123456789abcdef'
    process.env.INNGEST_SIGNING_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    const cfg = loadConfig()
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.port).toBe(3000)
    expect(cfg.appId).toBe('khoshut')
    expect(cfg.startupTimeoutMs).toBe(30000)
    expect(cfg.startupCheckIntervalMs).toBe(1000)
    expect(cfg.startupRequestTimeoutMs).toBe(5000)
  })

  it('rejects an invalid port', () => {
    process.env.PORT = '70000'
    expect(() => loadConfig()).toThrow('Invalid PORT value: 70000')
  })

  it('rejects an invalid inngest startup timeout', () => {
    process.env.INNGEST_EVENT_KEY = '0123456789abcdef0123456789abcdef'
    process.env.INNGEST_SIGNING_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    process.env.INNGEST_STARTUP_TIMEOUT_MS = '0'

    expect(() => loadConfig()).toThrow('Invalid INNGEST_STARTUP_TIMEOUT_MS value: 0')
  })
})
