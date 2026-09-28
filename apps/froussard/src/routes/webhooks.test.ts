import { fromBinary } from '@bufbuild/protobuf'
import { Effect, Layer } from 'effect'
import { make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest'

import { type AppConfig, AppConfigService } from '@/effect/config'
import type { AppRuntime } from '@/effect/runtime'
import { AppLogger } from '@/logger'
import { CommandEventSchema as FacteurCommandEventSchema } from '@/proto/proompteng/facteur/v1/contract_pb'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { GithubService } from '@/services/github/service'
import type { GithubServiceDefinition } from '@/services/github/service.types'
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

const AGENTS_AGENT_RUNS_URL = 'http://agents.test/v1/agent-runs'

const findAgentRunSubmission = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.find(([target]) => String(target) === AGENTS_AGENT_RUNS_URL) as [URL, RequestInit] | undefined

const expectAgentRunSubmission = (
  fetchMock: ReturnType<typeof vi.fn>,
  options: { deliveryId: string; issueNumber: number; issueTitle: string; issueUrl: string },
) => {
  const call = findAgentRunSubmission(fetchMock)
  expect(call).toBeTruthy()
  const [, init] = call as [URL, RequestInit]
  expect(init.method).toBe('POST')
  expect(init.headers).toMatchObject({
    accept: 'application/json',
    'content-type': 'application/json',
    'idempotency-key': options.deliveryId,
    'x-agents-client': 'froussard',
  })

  const expectedGoalObjective = [
    `Implement GitHub issue owner/repo#${options.issueNumber}: ${options.issueTitle}.`,
    `Issue URL: ${options.issueUrl}.`,
    'Base branch: main.',
    'Head branch: codex/issue-1-test.',
    'Use implementation.text for the full issue body, requirements, and acceptance criteria.',
  ].join('\n')

  const payload = JSON.parse(String(init.body)) as Record<string, unknown>
  const goal = payload.goal as { objective?: unknown } | undefined
  expect(goal?.objective).toBe(expectedGoalObjective)
  expect(goal?.objective).not.toBe('PROMPT')

  expect(payload).toMatchObject({
    namespace: 'agents',
    agentRef: { name: 'codex-agent' },
    implementation: {
      text: 'PROMPT',
      source: { provider: 'github', externalId: `owner/repo#${options.issueNumber}` },
    },
    goal: {
      objective: expectedGoalObjective,
      tokenBudget: 250000,
    },
    runtime: { type: 'job', config: { serviceAccountName: 'agents-sa' } },
    parameters: {
      repository: 'owner/repo',
      issueNumber: String(options.issueNumber),
      head: 'codex/issue-1-test',
      stage: 'implementation',
      deliveryId: options.deliveryId,
    },
    secrets: ['github-token', 'codex-auth'],
    policy: { secretBindingRef: 'codex-github-token' },
    vcsRef: { name: 'github' },
    vcsPolicy: { required: true, mode: 'read-write' },
    ttlSecondsAfterFinished: 86400,
  })
}

describe('createWebhookHandler', () => {
  let runtime: AppRuntime
  let publishedMessages: KafkaMessage[]
  let fetchMock: ReturnType<typeof vi.fn>
  let githubServiceMock: Mocked<GithubServiceDefinition>

  const webhooks = {
    verify: vi.fn(async () => true),
  }

  const baseConfig: WebhookConfig = {
    idempotency: {
      ttlMs: 60_000,
      maxEntries: 200,
    },
    atlas: {
      baseUrl: 'http://jangar',
      apiKey: null,
    },
    agents: {
      serviceBaseUrl: 'http://agents.test',
      serviceClientName: 'froussard',
      namespace: 'agents',
      agentName: 'codex-agent',
      linearAgentName: 'codex-linear-agent',
      vcsProviderName: 'github',
      serviceAccountName: 'agents-sa',
      secrets: ['github-token', 'codex-auth'],
      secretBindingRef: 'codex-github-token',
      ttlSecondsAfterFinished: 86400,
      goalTokenBudget: 250000,
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
      discordCommands: 'discord-topic',
      linearRaw: 'linear.webhook.events',
    },
    discord: {
      publicKey: 'public-key',
      response: {
        deferType: 'channel-message',
        ephemeral: true,
      },
    },
    linear: {
      enabled: true,
      webhookSecret: 'linear-secret',
      triggerLabel: 'agentrun',
      repository: 'proompteng/lab',
      baseBranch: 'main',
      branchPrefix: 'codex/linear-',
      maxBodyBytes: 1024 * 1024,
      webhookToleranceMs: 60_000,
      agentsTimeoutMs: 3_000,
    },
  }

  const provideRuntime = () => {
    const appConfig: AppConfig = {
      idempotency: {
        ttlMs: baseConfig.idempotency.ttlMs,
        maxEntries: baseConfig.idempotency.maxEntries,
      },
      githubWebhookSecret: 'secret',
      linearWebhookSecret: 'linear-secret',
      atlas: {
        baseUrl: baseConfig.atlas.baseUrl,
        apiKey: baseConfig.atlas.apiKey,
      },
      agents: baseConfig.agents,
      kafka: {
        brokers: ['localhost:9092'],
        username: 'user',
        password: 'pass',
        clientId: 'froussard-webhook-producer',
        topics: {
          raw: baseConfig.topics.raw,
          discordCommands: baseConfig.topics.discordCommands,
          linearRaw: baseConfig.topics.linearRaw,
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
      linear: {
        enabled: baseConfig.linear.enabled ?? true,
        triggerLabel: baseConfig.linear.triggerLabel,
        repository: baseConfig.linear.repository,
        baseBranch: baseConfig.linear.baseBranch,
        branchPrefix: baseConfig.linear.branchPrefix,
        maxBodyBytes: baseConfig.linear.maxBodyBytes,
        webhookToleranceMs: baseConfig.linear.webhookToleranceMs,
        agentsTimeoutMs: baseConfig.linear.agentsTimeoutMs,
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
      postIssueReaction: vi.fn<GithubServiceDefinition['postIssueReaction']>(() => Effect.succeed({ ok: true })),
      postIssueCommentReaction: vi.fn<GithubServiceDefinition['postIssueCommentReaction']>(() =>
        Effect.succeed({ ok: true }),
      ),
      issueHasReaction: vi.fn<GithubServiceDefinition['issueHasReaction']>(() =>
        Effect.succeed({ ok: true as const, hasReaction: true }),
      ),
      findLatestPlanComment: vi.fn<GithubServiceDefinition['findLatestPlanComment']>(() =>
        Effect.succeed({ ok: false, reason: 'not-found' }),
      ),
      fetchPullRequest: vi.fn<GithubServiceDefinition['fetchPullRequest']>(() =>
        Effect.succeed({ ok: false as const, reason: 'not-found' as const }),
      ),
      markPullRequestReadyForReview: vi.fn<GithubServiceDefinition['markPullRequestReadyForReview']>(() =>
        Effect.succeed({ ok: true }),
      ),
      createIssueComment: vi.fn<GithubServiceDefinition['createIssueComment']>(() => Effect.succeed({ ok: true })),
      createPullRequestComment: vi.fn<GithubServiceDefinition['createPullRequestComment']>(() =>
        Effect.succeed({ ok: true }),
      ),
      listPullRequestReviewThreads: vi.fn<GithubServiceDefinition['listPullRequestReviewThreads']>(() =>
        Effect.succeed({ ok: true as const, threads: [] }),
      ),
      listPullRequestCheckFailures: vi.fn<GithubServiceDefinition['listPullRequestCheckFailures']>(() =>
        Effect.succeed({ ok: true as const, checks: [] }),
      ),
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
        expect(publishedMessages).toHaveLength(1)
        expect(publishedMessages.some((message) => message.topic === 'github.issues.codex.tasks')).toBe(false)
        expectAgentRunSubmission(fetchMock, {
          deliveryId: 'delivery-issues-opened',
          issueNumber: 42,
          issueTitle: 'Implement feature',
          issueUrl: 'https://github.com/owner/repo/issues/42',
        })
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
        expect(publishedMessages.some((message) => message.topic === 'github.issues.codex.tasks')).toBe(false)
        expectAgentRunSubmission(fetchMock, {
          deliveryId: 'delivery-issue_comment-created',
          issueNumber: 99,
          issueTitle: 'Ship feature',
          issueUrl: 'https://github.com/owner/repo/issues/99',
        })
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
      idempotency: { ...baseConfig.idempotency, ...(configOverride?.idempotency ?? {}) },
      atlas: { ...baseConfig.atlas, ...(configOverride?.atlas ?? {}) },
      agents: { ...baseConfig.agents, ...(configOverride?.agents ?? {}) },
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
      expect(fetchMock.mock.calls.some(([target]) => String(target) === `${config.atlas.baseUrl}/api/enrich`)).toBe(
        false,
      )
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

  it('does not read or process Linear deliveries while intake is dormant', async () => {
    const handler = createWebhookHandler({
      runtime,
      webhooks: webhooks as never,
      config: { ...baseConfig, linear: { ...baseConfig.linear, enabled: false } },
    })
    const request = new Request('http://localhost/webhooks/linear', {
      method: 'POST',
      body: new ReadableStream({
        pull() {
          throw new Error('body must not be read while Linear intake is dormant')
        },
      }),
      duplex: 'half',
    } as RequestInit)

    const response = await handler(request, 'linear')

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
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

  it('ignores duplicate GitHub deliveries', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'opened',
      issue: {
        number: 3,
        title: 'Duplicate issue',
        body: 'Body',
        user: { login: 'USER' },
        html_url: 'https://example.com',
      },
      repository: { default_branch: 'main' },
      sender: { login: 'USER' },
    }

    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-dup-123',
      'x-hub-signature-256': 'sig',
      'content-type': 'application/json',
    }

    const first = await handler(buildRequest(payload, headers), 'github')
    const second = await handler(buildRequest(payload, headers), 'github')

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    const duplicateBody = await second.json()
    expect(duplicateBody).toMatchObject({ status: 'duplicate', deliveryId: 'delivery-dup-123' })

    expect(publishedMessages).toHaveLength(1)
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.filter(([target]) => String(target) === AGENTS_AGENT_RUNS_URL)).toHaveLength(1)
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
    expect(publishedMessages).toHaveLength(1)
    const [rawJsonMessage] = publishedMessages
    expectAgentRunSubmission(fetchMock, {
      deliveryId: 'delivery-123',
      issueNumber: 1,
      issueTitle: 'Test issue',
      issueUrl: 'https://example.com',
    })
    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-123' })
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: 'owner/repo',
        issueNumber: 1,
        reactionContent: '+1',
      }),
    )
    expect(findAgentRunSubmission(fetchMock)).toBeTruthy()
  })

  it('ignores duplicate github deliveries before publishing', async () => {
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

    const headers = {
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-dup',
      'x-hub-signature-256': 'sig',
      'content-type': 'application/json',
    }

    const response = await handler(buildRequest(payload, headers), 'github')
    expect(response.status).toBe(202)
    expect(publishedMessages).toHaveLength(1)
    expectAgentRunSubmission(fetchMock, {
      deliveryId: 'delivery-dup',
      issueNumber: 1,
      issueTitle: 'Test issue',
      issueUrl: 'https://example.com',
    })
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledTimes(1)

    const duplicateResponse = await handler(buildRequest(payload, headers), 'github')
    expect(duplicateResponse.status).toBe(202)
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      status: 'duplicate',
      deliveryId: 'delivery-dup',
    })
    expect(publishedMessages).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([target]) => String(target) === AGENTS_AGENT_RUNS_URL)).toHaveLength(1)
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledTimes(1)
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

    expect(publishedMessages).toHaveLength(1)
    const [rawJsonMessage] = publishedMessages
    expectAgentRunSubmission(fetchMock, {
      deliveryId: 'delivery-999',
      issueNumber: 2,
      issueTitle: 'Implementation issue',
      issueUrl: 'https://issue',
    })
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
    expect(publishedMessages).toHaveLength(1)
    expect(publishedMessages.some((message) => message.topic === 'raw-topic')).toBe(true)
  })

  it('does not post a codex review request comment for large pull requests', async () => {
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
    expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
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
    expect(publishedMessages).toHaveLength(1)
    expect(publishedMessages.some((message) => message.topic === 'raw-topic')).toBe(true)
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

  it('ignores duplicate Discord interactions', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

    const interactionPayload = {
      type: 5,
      id: 'interaction-dup-1',
      token: 'modal-token',
      data: { custom_id: 'plan:command-1', components: [] },
    }

    const headers = {
      'x-signature-ed25519': 'sig',
      'x-signature-timestamp': 'timestamp',
    }

    const first = await handler(buildDiscordRequest(interactionPayload, headers), 'discord')
    const second = await handler(buildDiscordRequest(interactionPayload, headers), 'discord')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({
      type: 4,
      data: {
        content: 'Duplicate interaction ignored.',
        flags: 64,
      },
    })

    expect(mockToPlanModalEvent).toHaveBeenCalledTimes(1)
    expect(publishedMessages).toHaveLength(1)
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
