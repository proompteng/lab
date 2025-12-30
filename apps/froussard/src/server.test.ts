import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppConfig } from '@/effect/config'

const ensureConnectedSpy = vi.fn()

vi.mock('@/effect/config', () => {
  const effect = require('effect') as typeof import('effect')
  const { Effect, Layer } = effect

  class AppConfigService extends Effect.Tag('@test/AppConfig')<AppConfigService, AppConfig>() {}

  const config: AppConfig = {
    githubWebhookSecret: 'secret',
    atlas: {
      baseUrl: 'http://jangar',
      apiKey: null,
    },
    kafka: {
      brokers: ['broker:9092'],
      username: 'user',
      password: 'pass',
      clientId: 'client',
      topics: {
        raw: 'raw',
        codexStructured: 'codex-structured',
        codexJudge: 'codex-judge',
        discordCommands: 'discord',
      },
    },
    codebase: {
      baseBranch: 'main',
      branchPrefix: 'codex/issue-',
    },
    codex: {
      triggerLogins: ['gregkonush'],
      workflowLogin: 'github-actions[bot]',
      implementationTriggerPhrase: 'implement issue',
    },
    discord: {
      publicKey: 'public',
      defaultResponse: { deferType: 'channel-message', ephemeral: true },
    },
    github: {
      token: 'token',
      ackReaction: '+1',
      apiBaseUrl: 'https://api.github.com',
      userAgent: 'agent',
    },
  }

  const AppConfigLayer = Layer.succeed(AppConfigService, config)

  return {
    AppConfigService,
    AppConfigLayer,
  }
})

vi.mock('@/services/kafka', () => {
  const effect = require('effect') as typeof import('effect')
  const { Effect, Layer } = effect

  class KafkaProducer extends Effect.Tag('@test/KafkaProducer')<
    KafkaProducer,
    {
      publish: (message: unknown) => ReturnType<typeof Effect.succeed>
      ensureConnected: ReturnType<typeof Effect.succeed>
      isReady: ReturnType<typeof Effect.succeed<boolean>>
    }
  >() {}

  const KafkaProducerLayer = Layer.succeed(KafkaProducer, {
    publish: () => Effect.succeed(undefined),
    ensureConnected: Effect.sync(() => {
      ensureConnectedSpy()
    }),
    isReady: Effect.succeed(true),
  })

  const parseBrokerList = (raw: string) => raw.split(',')

  return {
    KafkaProducer,
    KafkaProducerLayer,
    parseBrokerList,
  }
})

vi.mock('@/services/github/service', () => {
  const effect = require('effect') as typeof import('effect')
  const { Effect, Layer } = effect

  class GithubService extends Effect.Tag('@test/GithubService')<
    GithubService,
    {
      postIssueReaction: (options: unknown) => ReturnType<typeof Effect.succeed>
      postIssueCommentReaction: (options: unknown) => ReturnType<typeof Effect.succeed>
      issueHasReaction: (options: unknown) => ReturnType<typeof Effect.succeed>
      findLatestPlanComment: (options: unknown) => ReturnType<typeof Effect.succeed>
      fetchPullRequest: (options: unknown) => ReturnType<typeof Effect.succeed>
      markPullRequestReadyForReview: (options: unknown) => ReturnType<typeof Effect.succeed>
      createPullRequestComment: (options: unknown) => ReturnType<typeof Effect.succeed>
      listPullRequestReviewThreads: (options: unknown) => ReturnType<typeof Effect.succeed>
      listPullRequestCheckFailures: (options: unknown) => ReturnType<typeof Effect.succeed>
    }
  >() {}

  const GithubServiceLayer = Layer.succeed(GithubService, {
    postIssueReaction: () => Effect.succeed({ ok: true }),
    postIssueCommentReaction: () => Effect.succeed({ ok: true }),
    issueHasReaction: () => Effect.succeed({ ok: true, hasReaction: true }),
    findLatestPlanComment: () => Effect.succeed({ ok: false, reason: 'not-found' }),
    fetchPullRequest: () => Effect.succeed({ ok: false, reason: 'not-found' }),
    markPullRequestReadyForReview: () => Effect.succeed({ ok: true }),
    createPullRequestComment: () => Effect.succeed({ ok: true }),
    listPullRequestReviewThreads: () => Effect.succeed({ ok: true, threads: [] }),
    listPullRequestCheckFailures: () => Effect.succeed({ ok: true, checks: [] }),
  })

  return {
    GithubService,
    GithubServiceLayer,
  }
})

const mockCreateHealthHandlers = vi.fn(() => ({
  liveness: () => new Response('OK'),
  readiness: () => new Response('OK'),
}))

vi.mock('@/routes/health', () => ({
  createHealthHandlers: mockCreateHealthHandlers,
}))

const mockCreateWebhookHandler = vi.fn(() => vi.fn())

vi.mock('@/routes/webhooks', () => ({
  createWebhookHandler: mockCreateWebhookHandler,
  WebhookConfig: {} as never,
}))

const mockApp = {
  get: vi.fn(() => mockApp),
  on: vi.fn(() => mockApp),
  onError: vi.fn(() => mockApp),
  post: vi.fn(() => mockApp),
  listen: vi.fn((_port: number) => {
    mockApp.server = { hostname: '127.0.0.1', port: 8080 }
    return mockApp
  }),
  server: undefined as { hostname?: string; port?: number } | undefined,
}

vi.mock('elysia', () => ({
  Elysia: vi.fn(() => mockApp),
}))

vi.mock('@octokit/webhooks', () => ({
  Webhooks: vi.fn(() => ({ verify: vi.fn(async () => true) })),
}))

describe('server bootstrap', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
    }
    mockApp.server = undefined
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  it('bootstraps server without throwing and connects Kafka', async () => {
    const { startServer } = await import('@/index')
    startServer()

    expect(mockApp.listen).toHaveBeenCalled()
    await Promise.resolve()
    expect(ensureConnectedSpy).toHaveBeenCalled()
    expect(mockCreateHealthHandlers).toHaveBeenCalled()
    expect(mockCreateWebhookHandler).toHaveBeenCalled()
  }, 15_000)

  it('exposes build metadata on the root route', async () => {
    process.env.FROUSSARD_VERSION = '1.2.3'
    process.env.FROUSSARD_COMMIT = 'deadbeef'

    const { createApp } = await import('@/index')
    createApp()

    const rootCall = (mockApp.get.mock.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>).find(
      ([path]) => path === '/',
    )
    expect(rootCall).toBeDefined()

    const handler = rootCall?.[1]
    expect(handler).toBeTypeOf('function')
    const response = (await handler?.()) as Response | undefined
    expect(response).toBeInstanceOf(Response)
    if (!response) {
      throw new Error('expected root handler to return a response')
    }
    const payload = await response.json()
    expect(payload).toEqual({
      service: 'froussard',
      status: 'ok',
      version: '1.2.3',
      commit: 'deadbeef',
    })
  }, 15_000)
})
