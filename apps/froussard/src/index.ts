import { Webhooks } from '@octokit/webhooks'
import { Effect } from 'effect'
import { Elysia } from 'elysia'

import { AppConfigService } from '@/effect/config'
import { makeAppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { createHealthHandlers } from '@/routes/health'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { KafkaProducer } from '@/services/kafka'
import { traceRequest } from '@/telemetry'

const buildVersion = process.env.FROUSSARD_VERSION ?? 'dev'
const buildCommit = process.env.FROUSSARD_COMMIT ?? 'unknown'
const isLinearWebhookRequest = (request: Request | undefined) =>
  request ? new URL(request.url).pathname === '/webhooks/linear' : false

const runtime = makeAppRuntime()
const { config, kafka } = await runtime.runPromise(
  Effect.gen(function* () {
    return { config: yield* AppConfigService, kafka: yield* KafkaProducer }
  }),
)

export const createApp = () => {
  const health = createHealthHandlers({ runtime, kafka })

  const webhookConfig: WebhookConfig = {
    idempotency: config.idempotency,
    atlas: config.atlas,
    agents: config.agents,
    codebase: config.codebase,
    github: config.github,
    codexTriggerLogins: config.codex.triggerLogins,
    codexWorkflowLogin: config.codex.workflowLogin,
    codexImplementationTriggerPhrase: config.codex.implementationTriggerPhrase,
    topics: config.kafka.topics,
    linear: {
      webhookSecret: config.linearWebhookSecret,
      ...config.linear,
    },
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
    .get('/', ({ request }) =>
      runtime.runPromise(
        traceRequest(request, '/', () =>
          Response.json({
            service: 'froussard',
            status: 'ok',
            version: buildVersion,
            commit: buildCommit,
          }),
        ),
      ),
    )
    .get('/health/liveness', ({ request }) =>
      runtime.runPromise(traceRequest(request, '/health/liveness', health.liveness)),
    )
    .get('/health/readiness', ({ request }) =>
      runtime.runPromise(traceRequest(request, '/health/readiness', health.readiness)),
    )
    .onRequest((context) => {
      const { request } = context
      if (isLinearWebhookRequest(request)) return
      const url = new URL(request.url)
      logger.info({ method: request.method, path: url.pathname }, 'request received')
    })
    .onError((context) => {
      const { error, request } = context
      logger.error(isLinearWebhookRequest(request) ? { provider: 'linear' } : { err: error }, 'server error')
      return new Response('Internal Server Error', { status: 500 })
    })
    .post('/webhooks/:provider', ({ request, params }) =>
      runtime.runPromise(traceRequest(request, '/webhooks/:provider', () => webhookHandler(request, params.provider))),
    )
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

export const shutdown = async () => {
  try {
    await runtime.dispose()
  } catch (error) {
    logger.error({ err: error }, 'failed to dispose runtime')
  }
}

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
