import { fromBinary } from '@bufbuild/protobuf'
import { Effect, Layer } from 'effect'
import { make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppConfig, AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { AppLogger } from '@/logger'
import { CommandEventSchema as FacteurCommandEventSchema } from '@/proto/proompteng/facteur/v1/contract_pb'
import { CodexTaskSchema, CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { GithubService } from '@/services/github/service'
import { type KafkaMessage, KafkaProducer } from '@/services/kafka'

const { mockVerifyDiscordRequest, mockBuildPlanModalResponse, mockToPlanModalEvent, mockBuildCodexPrompt } = vi.hoisted(
  () => ({
    mockVerifyDiscordRequest: vi.fn(async () => true),
    mockBuildPlanModalResponse: vi.fn(() => ({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Implementation Run',
        components: [],
      },
    })),
    mockToPlanModalEvent: vi.fn(() => ({
      provider: 'discord' as const,
      interactionId: 'interaction-123',
      applicationId: 'app-123',
      command: 'plan',
      commandId: 'command-1',
      version: 1,
      token: 'token-123',
      options: { content: 'Ship the release with QA gating' },
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'user-1', username: 'tester', globalName: 'Tester', discriminator: '1234' },
      member: undefined,
      locale: 'en-US',
      guildLocale: 'en-US',
      response: { type: 4, flags: 64 },
      timestamp: '2025-10-09T00:00:00.000Z',
      correlationId: '',
      traceId: '',
    })),
    mockBuildCodexPrompt: vi.fn(() => 'PROMPT'),
  }),
)

vi.mock('@/discord-commands', () => ({
  verifyDiscordRequest: mockVerifyDiscordRequest,
  buildPlanModalResponse: mockBuildPlanModalResponse,
  toPlanModalEvent: mockToPlanModalEvent,
  INTERACTION_TYPE: { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, MODAL_SUBMIT: 5 },
}))

vi.mock('@/codex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/codex')>()
  return {
    ...actual,
    buildCodexBranchName: vi.fn(() => 'codex/issue-1-test'),
    buildCodexPrompt: mockBuildCodexPrompt,
    normalizeLogin: vi.fn((value: string | undefined | null) => (value ? value.toLowerCase() : null)),
  }
})

vi.mock('@/codex-workflow', () => ({
  selectReactionRepository: vi.fn((issueRepository, repository) => issueRepository ?? repository),
}))

vi.mock('@/github-payload', () => ({
  deriveRepositoryFullName: vi.fn(() => 'owner/repo'),
  isGithubIssueEvent: vi.fn((payload: unknown) => Boolean((payload as { issue?: unknown }).issue)),
  isGithubIssueCommentEvent: vi.fn((payload: unknown) => Boolean((payload as { issue?: unknown }).issue)),
}))

const buildRequest = (body: unknown, headers: Record<string, string>) => {
  return new Request('http://localhost/webhooks/github', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const buildDiscordRequest = (body: unknown, headers: Record<string, string> = {}) => {
  return new Request('http://localhost/webhooks/discord', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const toBuffer = (value: KafkaMessage['value']): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (typeof value === 'string') {
    return Buffer.from(value)
  }
  return Buffer.from(value)
}

describe('createWebhookHandler', () => {
  let runtime: AppRuntime
  let publishedMessages: KafkaMessage[]
  let fetchMock: ReturnType<typeof vi.fn>
  let githubServiceMock: {
    postIssueReaction: ReturnType<typeof vi.fn>
    postIssueCommentReaction: ReturnType<typeof vi.fn>
    issueHasReaction: ReturnType<typeof vi.fn>
    findLatestPlanComment: ReturnType<typeof vi.fn>
    fetchPullRequest: ReturnType<typeof vi.fn>
    markPullRequestReadyForReview: ReturnType<typeof vi.fn>
    createIssueComment: ReturnType<typeof vi.fn>
    createPullRequestComment: ReturnType<typeof vi.fn>
    listPullRequestReviewThreads: ReturnType<typeof vi.fn>
    listPullRequestCheckFailures: ReturnType<typeof vi.fn>
  }

  const webhooks = {
    verify: vi.fn(async () => true),
  }

  const baseConfig: WebhookConfig = {
    atlas: {
      baseUrl: 'http://jangar',
      apiKey: null,
    },
    codebase: {
      baseBranch: 'main',
      branchPrefix: 'codex/issue-',
    },
    github: {
      token: 'token',
      ackReaction: '+1',
      apiBaseUrl: 'https://api.github.com',
      userAgent: 'froussard',
    },
    codexTriggerLogins: ['user'],
    codexWorkflowLogin: 'github-actions[bot]',
    codexImplementationTriggerPhrase: 'implement issue',
    topics: {
      raw: 'raw-topic',
      codexStructured: 'github.issues.codex.tasks',
      codexJudge: 'github.webhook.codex.judge',
      discordCommands: 'discord-topic',
    },
    discord: {
      publicKey: 'public-key',
      response: {
        deferType: 'channel-message',
        ephemeral: true,
      },
    },
  }

  const provideRuntime = () => {
    const appConfig: AppConfig = {
      githubWebhookSecret: 'secret',
      atlas: {
        baseUrl: baseConfig.atlas.baseUrl,
        apiKey: baseConfig.atlas.apiKey,
      },
      kafka: {
        brokers: ['localhost:9092'],
        username: 'user',
        password: 'pass',
        clientId: 'froussard-webhook-producer',
        topics: {
          raw: baseConfig.topics.raw,
          codexStructured: baseConfig.topics.codexStructured,
          codexJudge: baseConfig.topics.codexJudge,
          discordCommands: baseConfig.topics.discordCommands,
        },
      },
      codebase: {
        baseBranch: baseConfig.codebase.baseBranch,
        branchPrefix: baseConfig.codebase.branchPrefix,
      },
      codex: {
        triggerLogins: [...baseConfig.codexTriggerLogins],
        workflowLogin: baseConfig.codexWorkflowLogin,
        implementationTriggerPhrase: baseConfig.codexImplementationTriggerPhrase,
      },
      discord: {
        publicKey: baseConfig.discord.publicKey,
        defaultResponse: {
          deferType: 'channel-message',
          ephemeral: baseConfig.discord.response.ephemeral,
        },
      },
      github: {
        token: baseConfig.github.token,
        ackReaction: baseConfig.github.ackReaction,
        apiBaseUrl: baseConfig.github.apiBaseUrl,
        userAgent: baseConfig.github.userAgent,
      },
    }
    const configLayer = Layer.succeed(AppConfigService, appConfig)
    const kafkaLayer = Layer.succeed(KafkaProducer, {
      publish: (message: KafkaMessage) =>
        Effect.sync(() => {
          publishedMessages.push(message)
        }),
      ensureConnected: Effect.succeed(undefined),
      isReady: Effect.succeed(true),
    })

    const loggerLayer = Layer.succeed(AppLogger, {
      debug: () => Effect.succeed(undefined),
      info: () => Effect.succeed(undefined),
      warn: () => Effect.succeed(undefined),
      error: () => Effect.succeed(undefined),
    })
    const githubLayer = Layer.succeed(GithubService, {
      postIssueReaction: githubServiceMock.postIssueReaction,
      postIssueCommentReaction: githubServiceMock.postIssueCommentReaction,
      issueHasReaction: githubServiceMock.issueHasReaction,
      findLatestPlanComment: githubServiceMock.findLatestPlanComment,
      fetchPullRequest: githubServiceMock.fetchPullRequest,
      markPullRequestReadyForReview: githubServiceMock.markPullRequestReadyForReview,
      createIssueComment: githubServiceMock.createIssueComment,
      createPullRequestComment: githubServiceMock.createPullRequestComment,
      listPullRequestReviewThreads: githubServiceMock.listPullRequestReviewThreads,
      listPullRequestCheckFailures: githubServiceMock.listPullRequestCheckFailures,
    })

    runtime = makeManagedRuntime(Layer.mergeAll(configLayer, loggerLayer, kafkaLayer, githubLayer))
  }

  beforeEach(() => {
    publishedMessages = []
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    mockVerifyDiscordRequest.mockReset()
    mockVerifyDiscordRequest.mockResolvedValue(true)
    mockBuildPlanModalResponse.mockReset()
    mockBuildPlanModalResponse.mockReturnValue({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Implementation Run',
        components: [],
      },
    })
    mockToPlanModalEvent.mockReset()
    mockToPlanModalEvent.mockReturnValue({
      provider: 'discord',
      interactionId: 'interaction-123',
      applicationId: 'app-123',
      command: 'plan',
      commandId: 'command-1',
      version: 1,
      token: 'token-123',
      options: { content: 'Ship the release with QA gating' },
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: 'user-1', username: 'tester', globalName: 'Tester', discriminator: '1234' },
      member: undefined,
      locale: 'en-US',
      guildLocale: 'en-US',
      response: { type: 4, flags: 64 },
      timestamp: '2025-10-09T00:00:00.000Z',
      correlationId: '',
      traceId: '',
    })
    mockBuildCodexPrompt.mockReset()
    mockBuildCodexPrompt.mockReturnValue('PROMPT')
    githubServiceMock = {
      postIssueReaction: vi.fn(() => Effect.succeed({ ok: true })),
      postIssueCommentReaction: vi.fn(() => Effect.succeed({ ok: true })),
      issueHasReaction: vi.fn(() => Effect.succeed({ ok: true as const, hasReaction: true })),
      findLatestPlanComment: vi.fn(() => Effect.succeed({ ok: false, reason: 'not-found' })),
      fetchPullRequest: vi.fn(() => Effect.succeed({ ok: false as const, reason: 'not-found' as const })),
      markPullRequestReadyForReview: vi.fn(() => Effect.succeed({ ok: true })),
      createIssueComment: vi.fn(() => Effect.succeed({ ok: true })),
      createPullRequestComment: vi.fn(() => Effect.succeed({ ok: true })),
      listPullRequestReviewThreads: vi.fn(() => Effect.succeed({ ok: true as const, threads: [] })),
      listPullRequestCheckFailures: vi.fn(() => Effect.succeed({ ok: true as const, checks: [] })),
    }
    provideRuntime()
  })

  afterEach(async () => {
    await runtime.dispose()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  interface Scenario {
    name: string
    event: string
    action?: string
    payload: Record<string, unknown>
    setup?: () => void
    assert: (body: unknown, response: Response) => Promise<void> | void
    configOverride?: Partial<WebhookConfig>
  }

  const scenarioHeaders = (event: string, action?: string) => ({
    'x-github-event': event,
    'x-github-delivery': `delivery-${event}-${action ?? 'none'}`,
    ...(action ? { 'x-github-action': action } : {}),
    'x-hub-signature-256': 'sig',
    'content-type': 'application/json',
  })

  const webhookScenarios: Scenario[] = [
    {
      name: 'queues implementation workflow when a Codex issue opens',
      event: 'issues',
      action: 'opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        issue: {
          number: 42,
          title: 'Implement feature',
          body: 'Detailed description',
          html_url: 'https://github.com/owner/repo/issues/42',
          user: { login: 'USER' },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        sender: { login: 'user' },
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: 'implementation' })
        expect(publishedMessages).toHaveLength(2)
        const implementationStructuredMessage = publishedMessages.find(
          (message) => message.topic === 'github.issues.codex.tasks',
        )
        expect(implementationStructuredMessage).toBeTruthy()
        expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryFullName: 'owner/repo',
            issueNumber: 42,
            reactionContent: '+1',
          }),
        )
        expect(mockBuildCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 42 }))
      },
    },
    {
      name: 'publishes implementation when manual override comment is received',
      event: 'issue_comment',
      action: 'created',
      payload: {
        action: 'created',
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        issue: {
          number: 99,
          title: 'Ship feature',
          body: 'Ticket body',
          html_url: 'https://github.com/owner/repo/issues/99',
          repository_url: 'https://api.github.com/repos/owner/repo',
          pull_request: {
            url: 'https://api.github.com/repos/owner/repo/pulls/99',
            html_url: 'https://github.com/owner/repo/pull/99',
          },
        },
        comment: {
          id: 555,
          html_url: 'https://github.com/owner/repo/issues/99#issuecomment-555',
          body: 'implement issue',
        },
        sender: { login: 'user' },
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: 'implementation' })
        expect(publishedMessages.filter((message) => message.topic === 'github.issues.codex.tasks')).toHaveLength(1)
        expect(githubServiceMock.postIssueCommentReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryFullName: 'owner/repo',
            commentId: 555,
            reactionContent: 'eyes',
          }),
        )
        expect(githubServiceMock.postIssueReaction).not.toHaveBeenCalled()
        expect(mockBuildCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 99 }))
      },
    },
    {
      name: 'posts ready comment when clean pull request updates',
      event: 'pull_request',
      action: 'edited',
      payload: {
        action: 'edited',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'user' },
        pull_request: {
          number: 9,
          head: { ref: 'codex/issue-9-clean', sha: 'cleansha' },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          user: { login: 'USER' },
        },
      },
      setup: () => {
        githubServiceMock.fetchPullRequest.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            pullRequest: {
              number: 9,
              title: 'Clean updates',
              body: '',
              htmlUrl: 'https://github.com/owner/repo/pull/9',
              draft: false,
              merged: false,
              state: 'open',
              additions: 12,
              deletions: 4,
              changedFiles: 3,
              headRef: 'codex/issue-9-clean',
              headSha: 'cleansha',
              baseRef: 'main',
              authorLogin: 'user',
              mergeableState: 'clean',
            },
          }),
        )
        githubServiceMock.listPullRequestReviewThreads.mockReturnValueOnce(
          Effect.succeed({ ok: true as const, threads: [] }),
        )
        githubServiceMock.listPullRequestCheckFailures.mockReturnValueOnce(
          Effect.succeed({ ok: true as const, checks: [] }),
        )
        githubServiceMock.findLatestPlanComment.mockReturnValueOnce(
          Effect.succeed({ ok: false as const, reason: 'not-found' as const }),
        )
        githubServiceMock.issueHasReaction.mockReturnValueOnce(Effect.succeed({ ok: true as const, hasReaction: true }))
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(githubServiceMock.issueHasReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryFullName: 'owner/repo',
            issueNumber: 9,
            reactionContent: '+1',
          }),
        )
        expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalled()
        expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
          expect.objectContaining({ body: expect.stringContaining(':shipit:') }),
        )
      },
    },
    {
      name: 'posts ready comment for non-codex branches once thumbs up reaction exists',
      event: 'pull_request',
      action: 'edited',
      payload: {
        action: 'edited',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'other-user' },
        pull_request: {
          number: 11,
          head: { ref: 'feature/new-ui', sha: 'xyz789' },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          user: { login: 'OTHER-USER' },
        },
      },
      setup: () => {
        githubServiceMock.fetchPullRequest.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            pullRequest: {
              number: 11,
              title: 'Feature work',
              body: '',
              htmlUrl: 'https://github.com/owner/repo/pull/11',
              draft: false,
              merged: false,
              state: 'open',
              additions: 8,
              deletions: 2,
              changedFiles: 1,
              headRef: 'feature/new-ui',
              headSha: 'xyz789',
              baseRef: 'main',
              authorLogin: 'other-user',
              mergeableState: 'clean',
            },
          }),
        )
        githubServiceMock.listPullRequestReviewThreads.mockReturnValueOnce(
          Effect.succeed({ ok: true as const, threads: [] }),
        )
        githubServiceMock.listPullRequestCheckFailures.mockReturnValueOnce(
          Effect.succeed({ ok: true as const, checks: [] }),
        )
        githubServiceMock.issueHasReaction.mockReturnValueOnce(Effect.succeed({ ok: true as const, hasReaction: true }))
        githubServiceMock.findLatestPlanComment.mockReturnValueOnce(
          Effect.succeed({ ok: false as const, reason: 'not-found' as const }),
        )
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(githubServiceMock.issueHasReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryFullName: 'owner/repo',
            issueNumber: 11,
            reactionContent: '+1',
          }),
        )
        expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
          expect.objectContaining({ body: expect.stringContaining(':shipit:') }),
        )
      },
    },
  ]

  it.each(webhookScenarios)('$name', async ({ event, action, payload, setup, assert, configOverride }) => {
    setup?.()
    const config: WebhookConfig = {
      ...baseConfig,
      ...(configOverride ?? {}),
      atlas: { ...baseConfig.atlas, ...(configOverride?.atlas ?? {}) },
      codebase: { ...baseConfig.codebase, ...(configOverride?.codebase ?? {}) },
      github: { ...baseConfig.github, ...(configOverride?.github ?? {}) },
      topics: { ...baseConfig.topics, ...(configOverride?.topics ?? {}) },
      discord: { ...baseConfig.discord, ...(configOverride?.discord ?? {}) },
    }
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config })

    const response = await handler(buildRequest(payload, scenarioHeaders(event, action)), 'github')

    expect(response.status).toBe(202)
    const body = await response.json()
    await assert(body, response)
    if (event === 'push') {
      const expectedDeliveryId = `delivery-${event}-${action ?? 'none'}`
      expect(fetchMock).toHaveBeenCalledWith(
        `${config.atlas.baseUrl}/api/enrich`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json',
            'x-github-delivery': expectedDeliveryId,
            'x-idempotency-key': expectedDeliveryId,
            'x-github-event': event,
          }),
        }),
      )
    } else {
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('rejects unsupported providers', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const response = await handler(
      new Request('http://localhost/webhooks/slack', { method: 'POST', body: '' }),
      'slack',
    )
    expect(response.status).toBe(400)
    expect(webhooks.verify).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 401 when signature header missing', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const response = await handler(buildRequest({}, {}), 'github')
    expect(response.status).toBe(401)
    expect(publishedMessages).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('publishes implementation message on issue opened', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'opened',
      issue: {
        number: 1,
        title: 'Test issue',
        body: 'Body',
        user: { login: 'USER' },
        html_url: 'https://example.com',
      },
      repository: { default_branch: 'main' },
      sender: { login: 'USER' },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-123',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    expect(publishedMessages).toHaveLength(2)
    const [implementationStructuredMessage, rawJsonMessage] = publishedMessages
    if (!implementationStructuredMessage) {
      throw new Error('missing structured message')
    }

    expect(implementationStructuredMessage).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-1-implementation',
    })
    expect(implementationStructuredMessage.headers?.['content-type']).toBe('application/x-protobuf')

    const implementationProto = fromBinary(CodexTaskSchema, toBuffer(implementationStructuredMessage.value))
    expect(implementationProto.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(implementationProto.repository).toBe('owner/repo')
    expect(implementationProto.issueNumber).toBe(BigInt(1))
    expect(implementationProto.deliveryId).toBe('delivery-123')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-123' })
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 1,
        reactionContent: '+1',
      }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('publishes implementation message when trigger comment is received', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'created',
      issue: {
        number: 2,
        title: 'Implementation issue',
        body: 'Body',
        html_url: 'https://issue',
      },
      repository: { default_branch: 'main' },
      sender: { login: 'USER' },
      comment: { body: 'implement issue' },
    }

    await handler(
      buildRequest(payload, {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-999',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(publishedMessages).toHaveLength(2)
    const [implementationStructuredMessage, rawJsonMessage] = publishedMessages
    if (!implementationStructuredMessage) {
      throw new Error('missing structured message')
    }

    expect(implementationStructuredMessage).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-2-implementation',
    })
    expect(implementationStructuredMessage.headers?.['content-type']).toBe('application/x-protobuf')

    const implementationProto = fromBinary(CodexTaskSchema, toBuffer(implementationStructuredMessage.value))
    expect(implementationProto.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(implementationProto.deliveryId).toBe('delivery-999')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-999' })
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 2,
        reactionContent: '+1',
      }),
    )
  })

  it('triggers atlas enrichment on push events', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      ref: 'refs/heads/main',
      after: 'abc123',
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      sender: { login: 'user' },
      head_commit: {
        id: 'abc123',
        added: [],
        modified: ['README.md'],
        removed: [],
      },
      commits: [
        {
          id: 'abc123',
          added: [],
          modified: ['README.md'],
          removed: [],
        },
      ],
    }

    const response = await handler(buildRequest(payload, scenarioHeaders('push')), 'github')

    expect(response.status).toBe(202)
    const expectedDeliveryId = 'delivery-push-none'
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseConfig.atlas.baseUrl}/api/enrich`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-github-delivery': expectedDeliveryId,
          'x-idempotency-key': expectedDeliveryId,
          'x-github-event': 'push',
        }),
      }),
    )
  })

  it('posts a ready comment when a clean Codex pull request updates outside forced review actions', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 9,
          title: 'Clean updates',
          body: '',
          htmlUrl: 'https://github.com/owner/repo/pull/9',
          draft: false,
          merged: false,
          state: 'open',
          additions: 24,
          deletions: 6,
          changedFiles: 4,
          headRef: 'codex/issue-9-clean',
          headSha: 'cleansha',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'edited',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 9,
        head: { ref: 'codex/issue-9-clean', sha: 'cleansha' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-review-clean-update',
        'x-github-action': 'edited',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: null })

    expect(githubServiceMock.issueHasReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 9,
        reactionContent: '+1',
      }),
    )
    expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 9,
        marker: expect.stringContaining('codex:ready'),
      }),
    )
    expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        pullNumber: 9,
        body: expect.stringContaining(':shipit:'),
      }),
    )
    expect(publishedMessages).toHaveLength(2)
    expect(publishedMessages.some((message) => message.topic === 'raw-topic')).toBe(true)
    expect(publishedMessages.some((message) => message.topic === baseConfig.topics.codexJudge)).toBe(true)
  })

  it('posts a codex review request comment for large pull requests', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 14,
          title: 'Large refactor',
          body: '',
          htmlUrl: 'https://github.com/owner/repo/pull/14',
          draft: false,
          merged: false,
          state: 'open',
          additions: 700,
          deletions: 350,
          changedFiles: 18,
          headRef: 'feature/big-change',
          headSha: 'bigsha',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )
    githubServiceMock.issueHasReaction.mockReturnValueOnce(Effect.succeed({ ok: true as const, hasReaction: false }))
    githubServiceMock.findLatestPlanComment.mockReturnValueOnce(
      Effect.succeed({ ok: false as const, reason: 'not-found' as const }),
    )

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'edited',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 14,
        head: { ref: 'feature/big-change', sha: 'bigsha' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(buildRequest(payload, scenarioHeaders('pull_request', 'edited')), 'github')

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: null })
    expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 14,
        marker: expect.stringContaining('codex:review-request'),
      }),
    )
    expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        pullNumber: 14,
        body: expect.stringContaining('@codex review'),
      }),
    )
  })

  it('does not post a ready comment when thumbs up reaction is absent', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 10,
          title: 'Needs thumbs up',
          body: '',
          htmlUrl: 'https://github.com/owner/repo/pull/10',
          draft: false,
          merged: false,
          state: 'open',
          additions: 18,
          deletions: 3,
          changedFiles: 2,
          headRef: 'codex/issue-10-clean',
          headSha: 'cleansha2',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )
    githubServiceMock.issueHasReaction.mockReturnValueOnce(Effect.succeed({ ok: true as const, hasReaction: false }))

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'edited',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 10,
        head: { ref: 'codex/issue-10-clean', sha: 'cleansha2' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(buildRequest(payload, scenarioHeaders('pull_request', 'edited')), 'github')

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: null })
    expect(githubServiceMock.issueHasReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 10,
        reactionContent: '+1',
      }),
    )
    expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
  })

  it('does not post a ready comment when merge conflicts are detected', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 12,
          title: 'Resolve conflicts',
          body: '',
          htmlUrl: 'https://github.com/owner/repo/pull/12',
          draft: false,
          merged: false,
          state: 'open',
          additions: 22,
          deletions: 5,
          changedFiles: 3,
          headRef: 'codex/issue-12-conflict',
          headSha: 'conflictsha',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'dirty',
        },
      }),
    )

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'synchronize',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 12,
        head: { ref: 'codex/issue-12-conflict', sha: 'conflictsha' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-review-conflict',
        'x-github-action': 'synchronize',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toMatchObject({ codexStageTriggered: null })

    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
    expect(publishedMessages.some((message) => message.topic === 'github.issues.codex.tasks')).toBe(false)
  })

  it('does not post a ready comment for draft pull requests', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 6,
          title: 'Ready PR',
          body: '',
          htmlUrl: 'https://github.com/owner/repo/pull/6',
          draft: true,
          merged: false,
          state: 'open',
          additions: 30,
          deletions: 8,
          changedFiles: 4,
          headRef: 'codex/issue-6-ready',
          headSha: 'def456',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'synchronize',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 6,
        head: { ref: 'codex/issue-6-ready', sha: 'def456' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-undraft-1',
        'x-github-action': 'synchronize',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(2)
    expect(publishedMessages.some((message) => message.topic === 'raw-topic')).toBe(true)
    expect(publishedMessages.some((message) => message.topic === baseConfig.topics.codexJudge)).toBe(true)
  })

  it('returns 401 when Discord signature verification fails', async () => {
    mockVerifyDiscordRequest.mockResolvedValueOnce(false)
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

    const response = await handler(
      buildDiscordRequest(
        {
          type: 2,
        },
        {
          'x-signature-ed25519': 'sig',
          'x-signature-timestamp': 'timestamp',
        },
      ),
      'discord',
    )

    expect(response.status).toBe(401)
    expect(publishedMessages).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns implementation modal response for slash command', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

    const response = await handler(
      buildDiscordRequest(
        {
          type: 2,
          id: 'interaction-123',
          token: 'token',
          data: {
            id: 'command-1',
            name: 'plan',
            type: 1,
          },
        },
        {
          'x-signature-ed25519': 'sig',
          'x-signature-timestamp': 'timestamp',
        },
      ),
      'discord',
    )

    expect(mockVerifyDiscordRequest).toHaveBeenCalled()
    expect(mockBuildPlanModalResponse).toHaveBeenCalled()
    expect(mockToPlanModalEvent).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload).toEqual({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Implementation Run',
        components: [],
      },
    })
  })

  it('publishes modal submissions and returns acknowledgement', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

    const response = await handler(
      buildDiscordRequest(
        {
          type: 5,
          id: 'interaction-123',
          token: 'modal-token',
          data: { custom_id: 'plan:command-1', components: [] },
        },
        {
          'x-signature-ed25519': 'sig',
          'x-signature-timestamp': 'timestamp',
        },
      ),
      'discord',
    )

    expect(mockVerifyDiscordRequest).toHaveBeenCalled()
    expect(mockToPlanModalEvent).toHaveBeenCalled()
    expect(mockBuildPlanModalResponse).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const [discordMessage] = publishedMessages
    if (!discordMessage) {
      throw new Error('missing discord message')
    }
    expect(discordMessage).toMatchObject({ topic: 'discord-topic', key: 'interaction-123' })
    const headers = discordMessage.headers ?? {}
    expect(headers['content-type']).toBe('application/x-protobuf')

    const protoEvent = fromBinary(FacteurCommandEventSchema, toBuffer(discordMessage.value))
    expect(protoEvent.options).toEqual(
      expect.objectContaining({
        content: 'Ship the release with QA gating',
        payload: expect.any(String),
      }),
    )

    const parsedPayload = JSON.parse(protoEvent.options.payload ?? '')
    expect(parsedPayload.prompt).toBe('Ship the release with QA gating')
    expect(parsedPayload.postToGithub).toBe(false)
    expect(parsedPayload.stage).toBe('implementation')
    expect(parsedPayload.runId).toBe('interaction-123')

    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload).toEqual({
      type: 4,
      data: {
        content: 'Implementation request received. Facteur will execute the workflow shortly.',
        flags: 64,
      },
    })
  })

  it('responds to Discord ping interactions', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

    const response = await handler(
      buildDiscordRequest(
        {
          type: 1,
        },
        {
          'x-signature-ed25519': 'sig',
          'x-signature-timestamp': 'timestamp',
        },
      ),
      'discord',
    )

    expect(mockBuildPlanModalResponse).not.toHaveBeenCalled()
    expect(mockToPlanModalEvent).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    const payload = await response.json()
    expect(payload).toEqual({ type: 1 })
  })
})
