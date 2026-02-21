import { afterEach, describe, expect, it } from 'bun:test'
import { loadConfig } from './config'

const ENV_KEYS = [
  'HOST',
  'PORT',
  'INNGEST_APP_ID',
  'INNGEST_BASE_URL',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
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
  })

  it('rejects an invalid port', () => {
    process.env.PORT = '70000'
    expect(() => loadConfig()).toThrow('Invalid PORT value: 70000')
  })
})
