import type { Webhooks } from '@octokit/webhooks'

import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { publishAdmission } from './admission'
import type { IdempotencyStore } from './idempotency-store'

export const createGithubWebhookHandler =
  ({
    runtime,
    webhooks,
    idempotencyStore,
  }: {
    runtime: AppRuntime
    webhooks: Webhooks
    idempotencyStore: IdempotencyStore
  }) =>
  async (rawBody: string, request: Request): Promise<Response> => {
    const signature = request.headers.get('x-hub-signature-256')
    if (!signature || !(await webhooks.verify(rawBody, signature))) return new Response('Unauthorized', { status: 401 })
    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return new Response('Invalid JSON body', { status: 400 })
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return new Response('Invalid payload', { status: 400 })
    const deliveryId = request.headers.get('x-github-delivery')?.trim()
    if (!deliveryId) return new Response('Missing delivery id', { status: 400 })
    const event = request.headers.get('x-github-event') ?? 'unknown'
    const headers: Record<string, string> = {
      'x-github-delivery': deliveryId,
      'x-github-event': event,
      'x-github-hook-id': request.headers.get('x-github-hook-id') ?? 'unknown',
      'x-hub-signature-256': signature,
      'content-type': request.headers.get('content-type') ?? 'application/json',
    }
    for (const name of ['traceparent', 'tracestate']) {
      const value = request.headers.get(name)
      if (value) headers[name] = value
    }
    const action = (payload as { action?: unknown }).action
    if (typeof action === 'string') headers['x-github-action'] = action
    try {
      const duplicate = await idempotencyStore.run(`github:${deliveryId}`, () =>
        publishAdmission(runtime, { provider: 'github', deliveryId, receivedAt: Date.now(), body: rawBody, headers }),
      )
      return Response.json(
        { status: duplicate ? 'duplicate' : 'accepted', deliveryId, event, action: action ?? null },
        { status: 202 },
      )
    } catch (error) {
      logger.error({ deliveryId, event, err: error }, 'github admission failed')
      return new Response('Kafka admission failed', { status: 503 })
    }
  }
