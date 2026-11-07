import { Webhooks } from '@octokit/webhooks'
import { Effect, Layer } from 'effect'
import { make as makeRuntime } from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppRuntime } from '@/effect/runtime'
import { KafkaProducer, type KafkaMessage } from '@/services/kafka'
import { ADMISSION_TOPIC, decodeAdmission, withDeadline } from './admission'
import { createGithubWebhookHandler } from './github-ingress'
import { createIdempotencyStore } from './idempotency-store'

const webhooks = new Webhooks({ secret: 'local-regression-secret' })
const body = JSON.stringify({ action: 'edited', repository: { full_name: 'owner/repo' }, pull_request: { number: 1 } })
const deliveryId = 'admission-regression'
const request = async (raw = body) =>
  new Request('http://localhost/webhooks/github', {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': 'pull_request',
      'x-hub-signature-256': await webhooks.sign(raw),
    },
  })
const harness = (publish: (message: KafkaMessage) => Promise<void>) => {
  const runtime = makeRuntime(
    Layer.succeed(KafkaProducer, {
      publish: (message) => Effect.tryPromise({ try: () => publish(message), catch: (error) => error }),
      ensureConnected: Effect.void,
      isReady: Effect.succeed(true),
    }),
  )
  const handler = createGithubWebhookHandler({
    runtime: runtime as AppRuntime,
    webhooks,
    idempotencyStore: createIdempotencyStore({ ttlMs: 60_000, maxEntries: 100 }),
  })
  return { runtime, handler }
}

afterEach(() => vi.useRealTimers())

describe('durable GitHub admission', () => {
  it('keeps overlapping deliveries pending until the broker confirms their single write', async () => {
    const write = Promise.withResolvers<void>()
    const publish = vi.fn<(message: KafkaMessage) => Promise<void>>(() => write.promise)
    const { handler, runtime } = harness(publish)
    const responses: Response[] = []
    try {
      const first = handler(body, await request()).then((response) => {
        responses.push(response)
        return response
      })
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
      const second = handler(body, await request()).then((response) => {
        responses.push(response)
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(responses).toHaveLength(0)
      write.resolve()
      const completed = await Promise.all([first, second])
      expect(completed.map((response) => response.status)).toEqual([202, 202])
      expect(await completed[1]!.json()).toMatchObject({ status: 'duplicate' })
      expect(publish).toHaveBeenCalledOnce()
      expect(publish.mock.calls[0]![0].topic).toBe(ADMISSION_TOPIC)
      expect(decodeAdmission(String(publish.mock.calls[0]![0].value))).toMatchObject({
        provider: 'github',
        deliveryId,
        body,
      })
    } finally {
      write.resolve()
      await runtime.dispose()
    }
  })

  it('fails both overlapping deliveries when the broker write fails and permits a real retry', async () => {
    const write = Promise.withResolvers<void>()
    const publish = vi
      .fn<(message: KafkaMessage) => Promise<void>>()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue(undefined)
    const { handler, runtime } = harness(publish)
    try {
      const first = handler(body, await request())
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
      const second = handler(body, await request())
      await new Promise((resolve) => setTimeout(resolve, 10))
      write.reject(new Error('broker unavailable'))
      expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([503, 503])
      expect((await handler(body, await request())).status).toBe(202)
      expect(publish).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects signed malformed JSON without reserving the delivery id', async () => {
    const publish = vi.fn(async () => undefined)
    const { handler, runtime } = harness(publish)
    try {
      expect((await handler('{', await request('{'))).status).toBe(400)
      expect((await handler(body, await request())).status).toBe(202)
      expect(publish).toHaveBeenCalledOnce()
    } finally {
      await runtime.dispose()
    }
  })

  it('requires a stable delivery id before admitting work', async () => {
    const publish = vi.fn(async () => undefined)
    const { handler, runtime } = harness(publish)
    try {
      const missing = await request()
      missing.headers.delete('x-github-delivery')
      expect((await handler(body, missing)).status).toBe(400)
      expect(publish).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })

  it('performs no GitHub policy calls while admitting a delivery', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('GitHub is down'))
    const { handler, runtime } = harness(async () => undefined)
    try {
      expect((await handler(body, await request())).status).toBe(202)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
      await runtime.dispose()
    }
  })

  it('bounds a stalled admission without turning the uncertain write into success', async () => {
    vi.useFakeTimers()
    const result = withDeadline(new Promise<void>(() => undefined), 8_000)
    const assertion = expect(result).rejects.toThrow('deadline exceeded')
    await vi.advanceTimersByTimeAsync(8_000)
    await assertion
  })
})
