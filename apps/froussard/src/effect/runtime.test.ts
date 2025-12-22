import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const producerFactory = vi.fn()
const kafkaConstructor = vi.fn(() => ({
  producer: producerFactory,
}))

vi.mock('kafkajs', () => ({
  Kafka: kafkaConstructor,
}))

const createProducer = () => {
  const connect = vi.fn().mockResolvedValue(undefined)
  const disconnect = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue(undefined)

  return { connect, disconnect, send }
}

describe('makeAppRuntime', () => {
  const originalEnv = process.env
  const requiredEnv = {
    GITHUB_WEBHOOK_SECRET: 'secret',
    KAFKA_BROKERS: 'broker:9092',
    KAFKA_USERNAME: 'user',
    KAFKA_PASSWORD: 'pass',
    KAFKA_TOPIC: 'raw-topic',
    KAFKA_CODEX_TOPIC_STRUCTURED: 'codex-topic-structured',
    KAFKA_DISCORD_COMMAND_TOPIC: 'discord.commands.incoming',
    DISCORD_PUBLIC_KEY: 'public-key',
  }
  let producers: Array<ReturnType<typeof createProducer>>

  beforeEach(() => {
    producers = []
    producerFactory.mockImplementation(() => {
      const producer = createProducer()
      producers.push(producer)
      return producer
    })
    kafkaConstructor.mockClear()
    process.env = {
      ...originalEnv,
      ...requiredEnv,
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.clearAllMocks()
  })

  it('provides AppConfigService and KafkaProducer without missing dependencies', async () => {
    const { makeAppRuntime } = await import('@/effect/runtime')
    const { AppConfigService } = await import('@/effect/config')
    const { KafkaProducer } = await import('@/services/kafka')

    const runtime = makeAppRuntime()

    const config = await runtime.runPromise(
      Effect.gen(function* (_) {
        return yield* AppConfigService
      }),
    )

    expect(config.githubWebhookSecret).toBe('secret')
    expect(config.kafka.brokers).toEqual(['broker:9092'])

    const kafka = await runtime.runPromise(
      Effect.gen(function* (_) {
        return yield* KafkaProducer
      }),
    )

    await runtime.runPromise(kafka.ensureConnected)

    expect(kafkaConstructor).toHaveBeenCalledTimes(1)
    expect(producerFactory).toHaveBeenCalledTimes(1)
    expect(producers).toHaveLength(1)
    expect(producers[0]?.connect).toHaveBeenCalledTimes(1)

    await runtime.dispose()
    expect(producers[0]?.disconnect).toHaveBeenCalledTimes(1)
  })
})
