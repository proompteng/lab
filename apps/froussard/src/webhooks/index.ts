import type { Webhooks } from '@octokit/webhooks'
import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'

import { createDiscordWebhookHandler } from './discord'
import { createGithubWebhookHandler } from './github'
import { createIdempotencyStore } from './idempotency-store'
import { createLinearWebhookHandler } from './linear'
import type { WebhookConfig } from './types'

export type { WebhookConfig } from './types'

interface WebhookDependencies {
  runtime: AppRuntime
  webhooks: Webhooks
  config: WebhookConfig
}

export const createWebhookHandler = ({ runtime, webhooks, config }: WebhookDependencies) => {
  const idempotencyStore = createIdempotencyStore(config.idempotency)
  const discordHandler = createDiscordWebhookHandler({ runtime, config, idempotencyStore })
  const githubHandler = createGithubWebhookHandler({ runtime, webhooks, config, idempotencyStore })
  const linearHandler = createLinearWebhookHandler({ runtime, config, idempotencyStore })

  return async (request: Request, provider: string): Promise<Response> => {
    if (provider === 'discord') {
      logger.info({ provider }, 'webhook request received')
      const bodyBuffer = new Uint8Array(await request.arrayBuffer())
      return discordHandler(bodyBuffer, request.headers)
    }

    if (provider === 'linear') {
      if (config.linear.enabled === false) {
        return new Response('Provider disabled', {
          status: 404,
          headers: { 'cache-control': 'no-store' },
        })
      }
      return linearHandler(request)
    }

    if (provider !== 'github') {
      logger.warn({ provider }, 'unsupported webhook provider')
      return new Response(`Provider '${provider}' not supported`, { status: 400 })
    }

    logger.info({ provider }, 'webhook request received')
    const rawBody = await request.text()
    return githubHandler(rawBody, request)
  }
}
