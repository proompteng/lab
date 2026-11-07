import { Effect, Option } from 'effect'
import { Headers, HttpTraceContext } from 'effect/http'
import type { Consumer, EachMessagePayload } from 'kafkajs'

import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { ADMISSION_TOPIC, decodeAdmission, type WebhookAdmission } from './admission'
import { createGithubPolicyProcessor } from './github'
import { createLinearPolicyProcessor } from './linear'
import type { WebhookConfig } from './types'

export const makePolicyProcessor = (runtime: AppRuntime, config: WebhookConfig) => {
  const github = createGithubPolicyProcessor({ runtime, config })
  const linear = createLinearPolicyProcessor({ runtime, config })
  return (admission: WebhookAdmission) =>
    runtime.runPromise(
      Effect.tryPromise({
        try: () => (admission.provider === 'github' ? github(admission) : linear(admission)),
        catch: (error) => error,
      }).pipe(
        Effect.withSpan('webhook.policy', {
          kind: 'consumer',
          parent: Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(admission.headers))),
          attributes: {
            'webhook.delivery.id': admission.deliveryId,
            'webhook.provider': admission.provider,
            'messaging.destination.name': ADMISSION_TOPIC,
          },
        }),
      ),
    )
}

export const createPolicyWorker = (consumer: Consumer, process: (admission: WebhookAdmission) => Promise<void>) => {
  let stopped = false
  let connected = false
  const handle = async ({ topic, partition, message, heartbeat }: EachMessagePayload) => {
    const admission = decodeAdmission(message.value?.toString())
    let heartbeatError: unknown
    const timer = setInterval(() => {
      void heartbeat().catch((error: unknown) => {
        heartbeatError = error
      })
    }, 3_000)
    try {
      while (!stopped) {
        if (heartbeatError) throw heartbeatError
        try {
          await process(admission)
          if (heartbeatError) throw heartbeatError
          if (stopped) return
          await consumer.commitOffsets([{ topic, partition, offset: String(BigInt(message.offset) + 1n) }])
          logger.info(
            { deliveryId: admission.deliveryId, topic, partition, offset: message.offset },
            'webhook policy committed',
          )
          return
        } catch (error) {
          logger.error(
            { deliveryId: admission.deliveryId, topic, partition, offset: message.offset, err: error },
            'webhook policy failed; offset retained',
          )
          if (stopped) return
          if (heartbeatError) throw heartbeatError
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          await heartbeat()
        }
      }
    } finally {
      clearInterval(timer)
    }
  }
  return {
    handle,
    async start() {
      await consumer.connect()
      connected = true
      await consumer.subscribe({ topics: [ADMISSION_TOPIC], fromBeginning: true })
      await consumer.run({ autoCommit: false, partitionsConsumedConcurrently: 3, eachMessage: handle })
    },
    async stop() {
      stopped = true
      if (connected) await consumer.disconnect()
    },
  }
}
