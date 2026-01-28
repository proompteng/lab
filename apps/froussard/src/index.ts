import '@/telemetry'

import { Webhooks } from '@octokit/webhooks'
import { SpanStatusCode, trace } from '@proompteng/otel/api'
import { SpanKind } from '@proompteng/otel/sdk-trace'
import { Effect } from 'effect'
import { Elysia } from 'elysia'

import { AppConfigService } from '@/effect/config'
import { makeAppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { createHealthHandlers } from '@/routes/health'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { KafkaProducer } from '@/services/kafka'

const buildVersion = process.env.FROUSSARD_VERSION ?? 'dev'
const buildCommit = process.env.FROUSSARD_COMMIT ?? 'unknown'

const runtime = makeAppRuntime()
const config = runtime.runSync(
  Effect.gen(function* (_) {
    return yield* AppConfigService
  }),
)
const kafka = runtime.runSync(
  Effect.gen(function* (_) {
    return yield* KafkaProducer
  }),
)

const recordRequestSpan = (request: Request, status?: number, error?: Error) => {
  const url = new URL(request.url)
  const tracer = trace.getTracer('froussard')
  const span = tracer.startSpan(`${request.method} ${url.pathname}`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': request.method,
      'http.route': url.pathname,
      'url.path': url.pathname,
      'url.scheme': url.protocol.replace(':', ''),
      'server.address': url.hostname,
    },
  })
  if (typeof status === 'number') {
    span.setAttribute('http.status_code', status)
    if (status >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR })
    }
  }
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    span.recordException(error)
  }
  span.end()
}

export const createApp = () => {
  const health = createHealthHandlers({ runtime, kafka })

  const webhookConfig: WebhookConfig = {
    idempotency: config.idempotency,
    atlas: config.atlas,
    codebase: config.codebase,
    github: config.github,
    codexTriggerLogins: config.codex.triggerLogins,
    codexWorkflowLogin: config.codex.workflowLogin,
    codexImplementationTriggerPhrase: config.codex.implementationTriggerPhrase,
    topics: config.kafka.topics,
    discord: {
      publicKey: config.discord.publicKey,
      response: config.discord.defaultResponse,
    },
  }

  const webhookHandler = createWebhookHandler({
    runtime,
    webhooks: new Webhooks({ secret: config.githubWebhookSecret }),
    config: webhookConfig,
  })

  return new Elysia()
    .get('/', () =>
      Response.json({
        service: 'froussard',
        status: 'ok',
        version: buildVersion,
        commit: buildCommit,
      }),
    )
    .get('/health/liveness', health.liveness)
    .get('/health/readiness', health.readiness)
    .onRequest((context) => {
      const { request } = context
      const url = new URL(request.url)
      logger.info({ method: request.method, path: url.pathname }, 'request received')
      recordRequestSpan(request)
    })
    .onError((context) => {
      const { error, request } = context
      logger.error({ err: error }, 'server error')
      if (request) {
        recordRequestSpan(request, 500, error instanceof Error ? error : undefined)
      }
      return new Response('Internal Server Error', { status: 500 })
    })
    .post('/webhooks/:provider', ({ request, params }) => webhookHandler(request, params.provider))
}

export const app = createApp()

export const startServer = () => {
  if (!app.server) {
    void runtime
      .runPromise(kafka.ensureConnected)
      .catch((error) => logger.error({ err: error }, 'failed to connect Kafka producer'))

    const port = Number(process.env.PORT ?? 8080)
    app.listen(port)
    const serverInfo = (app as { server?: { hostname?: string; port?: number } }).server
    const hostname = serverInfo?.hostname ?? '0.0.0.0'
    const resolvedPort = serverInfo?.port ?? port
    logger.info({ hostname, port: resolvedPort }, 'froussard server listening')
  }

  return app
}

if (import.meta.main) {
  startServer()
}

const shutdown = async () => {
  try {
    await runtime.dispose()
  } catch (error) {
    logger.error({ err: error }, 'failed to dispose runtime')
  }
}

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
