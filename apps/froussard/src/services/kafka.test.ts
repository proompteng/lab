import { Effect, Layer } from 'effect'
import { make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppConfig, AppConfigService } from '@/effect/config'
import { AppLogger } from '@/logger'
import { type KafkaMessage, KafkaProducer, KafkaProducerLayer, parseBrokerList } from '@/services/kafka'

const producerFactory = vi.fn()

vi.mock('kafkajs', () => {
  return {
    Kafka: vi.fn(function (config: AppConfig['kafka']) {
      return {
        producer: producerFactory,
        __config: config,
      }
    }),
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
    idempotency: {
      ttlMs: 60_000,
      maxEntries: 200,
    },
    githubWebhookSecret: 'secret',
    linearWebhookSecret: 'linear-secret',
    atlas: {
      baseUrl: 'http://jangar',
      apiKey: null,
    },
    agents: {
      serviceBaseUrl: 'http://agents.agents.svc.cluster.local',
      serviceClientName: 'froussard',
      namespace: 'agents',
      agentName: 'codex-agent',
      linearAgentName: 'codex-linear-agent',
      vcsProviderName: 'github',
      serviceAccountName: 'agents-sa',
      secrets: ['github-token', 'codex-auth'],
      secretBindingRef: 'codex-github-token',
      ttlSecondsAfterFinished: 86_400,
      goalTokenBudget: 250_000,
    },
    kafka: {
      brokers: ['broker:9092'],
      username: 'user',
      password: 'pass',
      clientId: 'test-client',
      topics: {
        raw: 'raw-topic',
        discordCommands: 'discord-topic',
        linearRaw: 'linear.webhook.events',
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
    linear: {
      enabled: true,
      triggerLabel: 'agentrun',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      branchPrefix: 'codex/linear-',
      maxBodyBytes: 1024 * 1024,
      webhookToleranceMs: 60_000,
      agentsTimeoutMs: 3_000,
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
    const send = vi.fn().mockResolvedValue([{ partition: 0, baseOffset: '1' }])
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
      Effect.gen(function* () {
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

  it('fails an uncertain write and permits a later broker-confirmed write', async () => {
    const producer = createProducer()
    producer.send.mockRejectedValueOnce(new Error('boom'))
    producerFactory.mockReturnValue(producer)
    const { runtime } = createRuntime()
    const kafka = runtime.runSync(KafkaProducer)
    try {
      await expect(runtime.runPromise(kafka.publish(baseMessage))).rejects.toThrow('boom')
      expect(runtime.runSync(kafka.isReady)).toBe(false)
      await runtime.runPromise(kafka.publish(baseMessage))
      expect(runtime.runSync(kafka.isReady)).toBe(true)
      expect(producer.send).toHaveBeenLastCalledWith(expect.objectContaining({ acks: -1, timeout: 3000 }))
    } finally {
      await runtime.dispose()
    }
  })

  it('disconnects producer when runtime is disposed', async () => {
    const producer = createProducer()
    producerFactory.mockReturnValue(producer)

    const { runtime } = createRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        return yield* KafkaProducer
      }),
    )

    await runtime.dispose()
    expect(producer.disconnect).toHaveBeenCalled()
  })

  it('does not serialize unrelated deliveries behind a stalled write', async () => {
    const producer = createProducer()
    const firstSend = Promise.withResolvers<Array<{ partition: number; baseOffset: string }>>()
    producer.send.mockImplementationOnce(() => firstSend.promise)
    producerFactory.mockReturnValue(producer)
    const { runtime } = createRuntime()
    const kafka = runtime.runSync(KafkaProducer)
    let firstAcknowledged = false
    const first = runtime.runPromise(kafka.publish({ ...baseMessage, key: 'first' })).then(() => {
      firstAcknowledged = true
    })
    try {
      await vi.waitFor(() => expect(producer.send).toHaveBeenCalledTimes(1))
      await runtime.runPromise(kafka.publish({ ...baseMessage, key: 'second' }))
      expect(firstAcknowledged).toBe(false)
      firstSend.resolve([{ partition: 0, baseOffset: '1' }])
      await first
      expect(firstAcknowledged).toBe(true)
      expect(producerFactory).toHaveBeenCalledWith(
        expect.objectContaining({ idempotent: true, maxInFlightRequests: 5 }),
      )
    } finally {
      firstSend.resolve([{ partition: 0, baseOffset: '1' }])
      await first
      await runtime.dispose()
    }
  })
})
