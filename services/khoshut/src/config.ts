export type KhoshutConfig = {
  host: string
  port: number
  appId: string
  baseUrl: string
  eventKey: string
  signingKey: string
}

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 3000
const DEFAULT_APP_ID = 'khoshut-bun'
const DEFAULT_BASE_URL = 'http://inngest.inngest.svc.cluster.local:8288'

const HEX_VALUE = /^[a-f0-9]+$/i

const parsePort = (input: string | undefined): number => {
  if (!input) return DEFAULT_PORT
  const parsed = Number.parseInt(input, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${input}`)
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
})

let cachedConfig: KhoshutConfig | null = null

export const getConfig = (): KhoshutConfig => {
  if (!cachedConfig) {
    cachedConfig = loadConfig()
  }
  return cachedConfig
}
