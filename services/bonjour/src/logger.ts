import pino, { multistream } from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const service = process.env.OTEL_SERVICE_NAME ?? 'bonjour'
const namespace = process.env.POD_NAMESPACE ?? 'default'
const lokiEndpoint = process.env.LGTM_LOKI_ENDPOINT
const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH
const versions = process.versions as Record<string, string | undefined>
const isBunRuntime = typeof versions.bun === 'string'
const lokiDisabled = isTruthy(process.env.LOKI_DISABLED)
const lokiForceEnabled = isTruthy(process.env.LOKI_FORCE_ENABLED)

const destinations: { stream: NodeJS.WritableStream }[] = [{ stream: process.stdout }]

if (lokiEndpoint && !lokiDisabled && (!isBunRuntime || lokiForceEnabled)) {
  try {
    const lokiStream = pino.transport({
      target: 'pino-loki',
      options: {
        host: lokiEndpoint,
        batching: true,
        interval: 5,
        timeout: 5000,
        labels: {
          service,
          namespace,
        },
        basicAuth: lokiBasicAuth,
      },
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
