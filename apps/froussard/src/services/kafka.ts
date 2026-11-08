import { Context, Effect, Layer, Ref } from 'effect'
import { Kafka } from 'kafkajs'

import { AppConfigService, type AppConfig } from '@/effect/config'
import { AppLogger } from '@/logger'

export { parseBrokerList } from '@/utils/kafka'

export interface KafkaMessage {
  topic: string
  key: string
  value: string | Uint8Array | Buffer
  headers?: Record<string, string | Uint8Array | Buffer>
}

export interface KafkaProducerService {
  readonly publish: (message: KafkaMessage) => Effect.Effect<void, unknown>
  readonly ensureConnected: Effect.Effect<void, unknown>
  readonly isReady: Effect.Effect<boolean>
}

export class KafkaProducer extends Context.Service<KafkaProducer, KafkaProducerService>()('@froussard/KafkaProducer') {}

export const makeKafkaClient = (config: AppConfig['kafka']) =>
  new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    ssl: false,
    sasl: { mechanism: 'scram-sha-512', username: config.username, password: config.password },
    connectionTimeout: 1_000,
    requestTimeout: 4_000,
    retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 500 },
  })

export const KafkaProducerLayer = Layer.effect(
  KafkaProducer,
  Effect.gen(function* () {
    const config = yield* AppConfigService
    const logger = yield* AppLogger
    const producer = makeKafkaClient(config.kafka).producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
      retry: { retries: 2, initialRetryTime: 100, maxRetryTime: 500 },
    })
    const ready = yield* Ref.make(false)
    let connection: Promise<void> | undefined
    const ensureConnected = Effect.tryPromise(() => {
      connection ??= producer.connect().catch((error: unknown) => {
        connection = undefined
        throw error
      })
      return connection
    }).pipe(Effect.tap(() => Ref.set(ready, true)))
    const publish = (message: KafkaMessage) =>
      ensureConnected.pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              producer.send({
                topic: message.topic,
                acks: -1,
                timeout: 3_000,
                messages: [
                  {
                    key: message.key,
                    value: typeof message.value === 'string' ? message.value : Buffer.from(message.value),
                    headers:
                      message.headers &&
                      Object.fromEntries(
                        Object.entries(message.headers).map(([key, value]) => [
                          key,
                          typeof value === 'string' ? value : Buffer.from(value),
                        ]),
                      ),
                  },
                ],
              }),
            catch: (error) => error,
          }),
        ),
        Effect.tap((receipts) =>
          logger.info('kafka write acknowledged', {
            topic: message.topic,
            key: message.key,
            receipts: JSON.stringify(receipts.map(({ partition, baseOffset }) => ({ partition, offset: baseOffset }))),
          }),
        ),
        Effect.tapError((error) =>
          Ref.set(ready, false).pipe(
            Effect.andThen(
              logger.error('kafka write failed', {
                topic: message.topic,
                key: message.key,
                error: String(error),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      )
    return yield* Effect.acquireRelease(
      Effect.succeed<KafkaProducerService>({ publish, ensureConnected, isReady: Ref.get(ready) }),
      () =>
        Effect.tryPromise(() => producer.disconnect()).pipe(
          Effect.catch((error) => logger.warn('Kafka disconnect failed', { error: String(error) })),
        ),
    )
  }),
)
