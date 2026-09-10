export type KhoshutConfig = {
  host: string
  port: number
  appId: string
  baseUrl: string
  eventKey: string
  signingKey: string
  startupTimeoutMs: number
  startupCheckIntervalMs: number
  startupRequestTimeoutMs: number
}

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 3000
const DEFAULT_APP_ID = 'khoshut'
const DEFAULT_BASE_URL = 'http://inngest.inngest.svc.cluster.local:8288'
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_STARTUP_CHECK_INTERVAL_MS = 1_000
const DEFAULT_STARTUP_REQUEST_TIMEOUT_MS = 5_000

const HEX_VALUE = /^[a-f0-9]+$/i

const parsePort = (input: string | undefined): number => {
  if (!input) return DEFAULT_PORT
  const parsed = Number.parseInt(input, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${input}`)
  }
  return parsed
}

const parsePositiveInteger = (
  input: string | undefined,
  defaultValue: number,
  envName: 'INNGEST_STARTUP_TIMEOUT_MS' | 'INNGEST_STARTUP_CHECK_INTERVAL_MS' | 'INNGEST_STARTUP_REQUEST_TIMEOUT_MS',
): number => {
  if (!input) return defaultValue
  const parsed = Number.parseInt(input, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${envName} value: ${input}`)
  }
  return parsed
}

const readHex = (name: 'INNGEST_EVENT_KEY' | 'INNGEST_SIGNING_KEY'): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  if (!HEX_VALUE.test(value)) {
    throw new Error(`${name} must be a hexadecimal string`)
  }
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 hex chars`)
  }
  return value
}

export const loadConfig = (): KhoshutConfig => ({
  host: process.env.HOST ?? DEFAULT_HOST,
  port: parsePort(process.env.PORT),
  appId: process.env.INNGEST_APP_ID ?? DEFAULT_APP_ID,
  baseUrl: process.env.INNGEST_BASE_URL ?? DEFAULT_BASE_URL,
  eventKey: readHex('INNGEST_EVENT_KEY'),
  signingKey: readHex('INNGEST_SIGNING_KEY'),
  startupTimeoutMs: parsePositiveInteger(
    process.env.INNGEST_STARTUP_TIMEOUT_MS,
    DEFAULT_STARTUP_TIMEOUT_MS,
    'INNGEST_STARTUP_TIMEOUT_MS',
  ),
  startupCheckIntervalMs: parsePositiveInteger(
    process.env.INNGEST_STARTUP_CHECK_INTERVAL_MS,
    DEFAULT_STARTUP_CHECK_INTERVAL_MS,
    'INNGEST_STARTUP_CHECK_INTERVAL_MS',
  ),
  startupRequestTimeoutMs: parsePositiveInteger(
    process.env.INNGEST_STARTUP_REQUEST_TIMEOUT_MS,
    DEFAULT_STARTUP_REQUEST_TIMEOUT_MS,
    'INNGEST_STARTUP_REQUEST_TIMEOUT_MS',
  ),
})

let cachedConfig: KhoshutConfig | null = null

export const getConfig = (): KhoshutConfig => {
  if (!cachedConfig) {
    cachedConfig = loadConfig()
  }
  return cachedConfig
}
