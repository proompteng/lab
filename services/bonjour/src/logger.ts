import pino, { multistream } from 'pino'
import { pinoLoki } from 'pino-loki'

const level = process.env.LOG_LEVEL ?? 'info'
const service = process.env.OTEL_SERVICE_NAME ?? 'bonjour'
const namespace = process.env.POD_NAMESPACE ?? 'default'
const lokiEndpoint = process.env.LGTM_LOKI_ENDPOINT
const lokiBasicAuth = parseLokiBasicAuth(process.env.LGTM_LOKI_BASIC_AUTH)
const lokiDisabled = isTruthy(process.env.LOKI_DISABLED)

const destinations: { stream: NodeJS.WritableStream }[] = [{ stream: process.stdout }]

if (lokiEndpoint && !lokiDisabled) {
  try {
    const lokiStream = pinoLoki({
      host: lokiEndpoint,
      batching: true,
      interval: 5,
      timeout: 5000,
      replaceTimestamp: true,
      labels: {
        service,
        namespace,
      },
      basicAuth: lokiBasicAuth,
    })

    destinations.push({ stream: lokiStream })
  } catch (error) {
    // Fallback to stdout logging if the Loki transport cannot be initialised.
    console.warn('failed to initialise pino-loki transport', error)
  }
}

export const logger = pino(
  {
    level,
    base: {
      service,
      namespace,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  multistream(destinations),
)

function isTruthy(value?: string) {
  if (!value) {
    return false
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function parseLokiBasicAuth(value?: string) {
  if (!value) {
    return undefined
  }
  const direct = parseUserPass(value)
  if (direct) {
    return direct
  }
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return parseUserPass(decoded)
  } catch {
    return undefined
  }
}

function parseUserPass(value: string) {
  const [username, ...rest] = value.split(':')
  if (!username || rest.length === 0) {
    return undefined
  }
  const password = rest.join(':')
  if (!password) {
    return undefined
  }
  return { username, password }
}
