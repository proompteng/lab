import os from 'node:os'

import { Effect, Layer } from 'effect'
import pino, { multistream } from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const service = process.env.OTEL_SERVICE_NAME ?? process.env.LGTM_SERVICE_NAME ?? 'froussard'
const namespace = process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'default'
const hostname = process.env.POD_NAME ?? process.env.HOSTNAME ?? os.hostname()
const lokiEndpoint = process.env.LGTM_LOKI_ENDPOINT
const lokiBasicAuth = process.env.LGTM_LOKI_BASIC_AUTH

const destinations: pino.StreamEntry[] = [{ stream: process.stdout }]

if (lokiEndpoint) {
  try {
    const { host, endpoint } = normaliseLokiEndpoint(lokiEndpoint)

    const lokiStream = pino.transport({
      target: 'pino-loki',
      options: {
        host,
        endpoint,
        batching: true,
        interval: 5,
        timeout: 5000,
        replaceTimestamp: true,
        labels: {
          service,
          namespace,
          hostname,
        },
        basicAuth: lokiBasicAuth,
      },
    })

    destinations.push({ stream: lokiStream })
  } catch (error) {
    // eslint-disable-next-line no-console -- logger initialisation fallback
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

export function normaliseLokiEndpoint(value: string): { host: string; endpoint?: string } {
  try {
    const parsed = new URL(value)
    const endpoint = parsed.pathname === '/' ? undefined : parsed.pathname
    return { host: `${parsed.protocol}//${parsed.host}`, endpoint }
  } catch {
    return { host: value }
  }
}

export interface AppLoggerService {
  readonly debug: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
  readonly info: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
  readonly warn: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
  readonly error: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
}

const logWith = (level: 'debug' | 'info' | 'warn' | 'error') => {
  return (message: string, fields?: Record<string, unknown>) =>
    Effect.sync(() => {
      if (fields && Object.keys(fields).length > 0) {
        logger[level](fields, message)
      } else {
        logger[level](message)
      }
    })
}

export class AppLogger extends Effect.Tag('@froussard/AppLogger')<AppLogger, AppLoggerService>() {}

export const AppLoggerLayer = Layer.sync(AppLogger, () => ({
  debug: logWith('debug'),
  info: logWith('info'),
  warn: logWith('warn'),
  error: logWith('error'),
}))
