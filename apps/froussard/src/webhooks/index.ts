import type { Webhooks } from '@octokit/webhooks'
import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'

import { createDiscordWebhookHandler } from './discord'
import { createGithubWebhookHandler } from './github'
import { createIdempotencyStore } from './idempotency-store'
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

  return async (request: Request, provider: string): Promise<Response> => {
    logger.info({ provider }, 'webhook request received')

    if (provider === 'discord') {
      const bodyBuffer = new Uint8Array(await request.arrayBuffer())
      return discordHandler(bodyBuffer, request.headers)
    }

    if (provider !== 'github') {
      const preview = await request.text()
      logger.warn({ provider, preview }, 'unsupported webhook provider')
      return new Response(`Provider '${provider}' not supported`, { status: 400 })
    }

    const rawBody = await request.text()
    return githubHandler(rawBody, request)
  }
}
