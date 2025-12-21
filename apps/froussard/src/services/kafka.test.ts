import { Effect, Layer } from 'effect'
import { make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppConfig, AppConfigService } from '@/effect/config'
import { AppLogger } from '@/logger'
import { type KafkaMessage, KafkaProducer, KafkaProducerLayer, parseBrokerList } from '@/services/kafka'

const producerFactory = vi.fn()

vi.mock('kafkajs', () => {
  return {
    Kafka: vi.fn((config: AppConfig['kafka']) => ({
      producer: producerFactory,
      __config: config,
    })),
  }
})

describe('parseBrokerList', () => {
  it('splits and trims brokers, removing empties', () => {
    expect(parseBrokerList('broker1:9092, broker2:19092, ,')).toEqual(['broker1:9092', 'broker2:19092'])
  })

  it('returns empty array when input is blank', () => {
    expect(parseBrokerList('   ')).toEqual([])
  })
})

describe('KafkaProducerLayer', () => {
  const baseConfig: AppConfig = {
    githubWebhookSecret: 'secret',
    kafka: {
      brokers: ['broker:9092'],
      username: 'user',
      password: 'pass',
      clientId: 'test-client',
      topics: {
        raw: 'raw-topic',
        codex: 'codex-topic',
        codexStructured: 'github.issues.codex.tasks',
        discordCommands: 'discord-topic',
      },
      sasl: {
        mechanism: 'scram-sha-512',
        username: 'user',
        password: 'pass',
      },
    },
    codebase: {
      baseBranch: 'main',
      branchPrefix: 'codex/issue-',
    },
    codex: {
      triggerLogins: ['user'],
      workflowLogin: 'github-actions[bot]',
      implementationTriggerPhrase: 'implement issue',
    },
    discord: {
      publicKey: 'public',
      defaultResponse: {
        deferType: 'channel-message',
        ephemeral: true,
      },
    },
    github: {
      token: 'token',
      ackReaction: '+1',
      apiBaseUrl: 'https://api.github.com',
      userAgent: 'froussard',
    },
  }

  const baseMessage: KafkaMessage = {
    topic: 'test-topic',
    key: 'key1',
    value: 'value1',
    headers: {},
  }

  const createProducer = () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const send = vi.fn().mockResolvedValue(undefined)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    return { connect, send, disconnect }
  }

  const createRuntime = () => {
    const configLayer = Layer.succeed(AppConfigService, baseConfig)
    const loggerLayer = Layer.succeed(AppLogger, {
      debug: () => Effect.succeed(undefined),
      info: () => Effect.succeed(undefined),
      warn: () => Effect.succeed(undefined),
      error: () => Effect.succeed(undefined),
    })

    const layer = KafkaProducerLayer.pipe(Layer.provide(configLayer), Layer.provide(loggerLayer))
    const runtime = makeManagedRuntime(layer)

    return { runtime }
  }

  beforeEach(() => {
    producerFactory.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('connects on first publish and reuses producer', async () => {
    const producer = createProducer()
    producerFactory.mockReturnValue(producer)

    const { runtime } = createRuntime()
    const kafka = await runtime.runPromise(
      Effect.gen(function* (_) {
        return yield* KafkaProducer
      }),
    )

    await runtime.runPromise(kafka.publish(baseMessage))

    expect(producerFactory).toHaveBeenCalledTimes(1)
    expect(producer.connect).toHaveBeenCalledTimes(1)
    expect(producer.send).toHaveBeenCalledTimes(1)

    const ready = await runtime.runPromise(kafka.isReady)
    expect(ready).toBe(true)

    await runtime.dispose()
  })

  it('recreates producer after send failure', async () => {
    const firstProducer = createProducer()
    firstProducer.send.mockRejectedValueOnce(new Error('boom'))
    const secondProducer = createProducer()

    producerFactory.mockImplementationOnce(() => firstProducer).mockImplementationOnce(() => secondProducer)

    const { runtime } = createRuntime()
    const kafka = await runtime.runPromise(
      Effect.gen(function* (_) {
        return yield* KafkaProducer
      }),
    )

    await expect(runtime.runPromise(kafka.publish(baseMessage))).rejects.toThrow('boom')

    expect(firstProducer.connect).toHaveBeenCalled()
    expect(firstProducer.send).toHaveBeenCalled()
    expect(firstProducer.disconnect).toHaveBeenCalled()

    await runtime.runPromise(kafka.publish(baseMessage))

    expect(producerFactory).toHaveBeenCalledTimes(2)
    expect(secondProducer.connect).toHaveBeenCalledTimes(1)
    expect(secondProducer.send).toHaveBeenCalledTimes(1)

    await runtime.dispose()
  })

  it('disconnects producer when runtime is disposed', async () => {
    const producer = createProducer()
    producerFactory.mockReturnValue(producer)

    const { runtime } = createRuntime()
    await runtime.runPromise(
      Effect.gen(function* (_) {
        return yield* KafkaProducer
      }),
    )

    await runtime.dispose()
    expect(producer.disconnect).toHaveBeenCalled()
  })
})
