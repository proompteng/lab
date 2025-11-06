import { fromBinary } from '@bufbuild/protobuf'
import { Effect, Layer } from 'effect'
import { type ManagedRuntime, make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PLAN_COMMENT_MARKER } from '@/codex'
import { AppLogger } from '@/logger'
import { CommandEventSchema as FacteurCommandEventSchema } from '@/proto/proompteng/facteur/v1/contract_pb'
import { CodexTaskSchema, CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { GithubService } from '@/services/github/service'
import { type KafkaMessage, KafkaProducer } from '@/services/kafka'
import { clearReviewFingerprintCacheForTest } from '@/webhooks/github/review-fingerprint'

const { mockVerifyDiscordRequest, mockBuildPlanModalResponse, mockToPlanModalEvent, mockBuildCodexPrompt } = vi.hoisted(
  () => ({
    mockVerifyDiscordRequest: vi.fn(async () => true),
    mockBuildPlanModalResponse: vi.fn(() => ({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Planning Run',
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
  let runtime: ManagedRuntime<unknown, never>
  let publishedMessages: KafkaMessage[]
  let githubServiceMock: {
    postIssueReaction: ReturnType<typeof vi.fn>
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
    codexTriggerLogin: 'user',
    codexWorkflowLogin: 'github-actions[bot]',
    codexImplementationTriggerPhrase: 'execute plan',
    topics: {
      raw: 'raw-topic',
      codex: 'codex-topic',
      codexStructured: 'github.issues.codex.tasks',
      discordCommands: 'discord-topic',
    },
    discord: {
      publicKey: 'public-key',
      response: {
        deferType: 'channel-message',
        ephemeral: true,
      },
    },
    flags: {
      skipPlanningPlaceholder: true,
    },
  }

  const provideRuntime = () => {
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
      issueHasReaction: githubServiceMock.issueHasReaction,
      findLatestPlanComment: githubServiceMock.findLatestPlanComment,
      fetchPullRequest: githubServiceMock.fetchPullRequest,
      markPullRequestReadyForReview: githubServiceMock.markPullRequestReadyForReview,
      createIssueComment: githubServiceMock.createIssueComment,
      createPullRequestComment: githubServiceMock.createPullRequestComment,
      listPullRequestReviewThreads: githubServiceMock.listPullRequestReviewThreads,
      listPullRequestCheckFailures: githubServiceMock.listPullRequestCheckFailures,
    })

    runtime = makeManagedRuntime(Layer.mergeAll(loggerLayer, kafkaLayer, githubLayer))
  }

  beforeEach(() => {
    publishedMessages = []
    mockVerifyDiscordRequest.mockReset()
    mockVerifyDiscordRequest.mockResolvedValue(true)
    mockBuildPlanModalResponse.mockReset()
    mockBuildPlanModalResponse.mockReturnValue({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Planning Run',
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
    clearReviewFingerprintCacheForTest()
  })

  afterEach(async () => {
    await runtime.dispose()
    vi.clearAllMocks()
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
      name: 'queues planning workflow when a Codex issue opens',
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
        expect(body).toMatchObject({ codexStageTriggered: 'planning' })
        expect(publishedMessages).toHaveLength(3)
        const planningJsonMessage = publishedMessages.find((message) => message.topic === 'codex-topic')
        expect(planningJsonMessage).toBeTruthy()
        const planningStructuredMessage = publishedMessages.find(
          (message) => message.topic === 'github.issues.codex.tasks',
        )
        expect(planningStructuredMessage).toBeTruthy()
        expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
          expect.objectContaining({ repositoryFullName: 'owner/repo', issueNumber: 42 }),
        )
        expect(mockBuildCodexPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ stage: 'planning', issueNumber: 42 }),
        )
      },
    },
    {
      name: 'skips planning workflow when issue body already contains a plan comment',
      event: 'issues',
      action: 'opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        issue: {
          number: 73,
          title: 'Existing plan',
          body: `${PLAN_COMMENT_MARKER}\n### Objective\n- keep existing plan`,
          html_url: 'https://github.com/owner/repo/issues/73',
        },
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(githubServiceMock.postIssueReaction).not.toHaveBeenCalled()
        expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
        expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
        expect(publishedMessages).toHaveLength(1)
        expect(publishedMessages[0].topic).toBe('raw-topic')
      },
    },
    {
      name: 'skips planning workflow when a plan comment already exists on the issue',
      event: 'issues',
      action: 'opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        issue: {
          number: 74,
          title: 'Plan already published',
          body: 'Initial request without plan',
          html_url: 'https://github.com/owner/repo/issues/74',
          user: { login: 'USER' },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        sender: { login: 'user' },
      },
      configOverride: {
        flags: { skipPlanningPlaceholder: false },
      },
      setup: () => {
        githubServiceMock.findLatestPlanComment.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            comment: {
              id: 123,
              body: `${PLAN_COMMENT_MARKER}\n### Objective\n- manual plan`,
              htmlUrl: 'https://github.com/owner/repo/issues/74#issuecomment-1',
            },
          }),
        )
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(githubServiceMock.postIssueReaction).not.toHaveBeenCalled()
        expect(githubServiceMock.createIssueComment).not.toHaveBeenCalled()
        expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalled()
        expect(publishedMessages).toHaveLength(1)
        expect(publishedMessages[0].topic).toBe('raw-topic')
      },
    },
    {
      name: 'promotes implementation when plan comment arrives',
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
        },
        comment: {
          id: 555,
          html_url: 'https://github.com/owner/repo/issues/99#issuecomment-555',
          body: '<!-- codex:plan -->\n- step',
        },
        sender: { login: 'user' },
      },
      setup: () => {
        githubServiceMock.findLatestPlanComment.mockResolvedValue({ ok: false, reason: 'not-found' })
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: 'implementation' })
        expect(publishedMessages.filter((message) => message.topic === 'codex-topic')).toHaveLength(1)
        expect(mockBuildCodexPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ stage: 'implementation', issueNumber: 99 }),
        )
      },
    },
    {
      name: 'does not publish review message when outstanding feedback exists without comment trigger',
      event: 'pull_request',
      action: 'synchronize',
      payload: {
        action: 'synchronize',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'user' },
        pull_request: {
          number: 5,
          head: { ref: 'codex/issue-5-branch', sha: 'abc123' },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          user: { login: 'USER' },
        },
      },
      setup: () => {
        githubServiceMock.fetchPullRequest.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            pullRequest: {
              number: 5,
              title: 'Update webhook handler',
              body: 'Adds new logic',
              htmlUrl: 'https://github.com/owner/repo/pull/5',
              draft: false,
              merged: false,
              state: 'open',
              headRef: 'codex/issue-5-branch',
              headSha: 'abc123',
              baseRef: 'main',
              authorLogin: 'user',
              mergeableState: 'blocked',
            },
          }),
        )
        githubServiceMock.listPullRequestReviewThreads.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            threads: [
              {
                summary: 'Add unit tests for webhook logic',
                url: 'https://github.com/owner/repo/pull/5#discussion-1',
                author: 'octocat',
              },
            ],
          }),
        )
        githubServiceMock.listPullRequestCheckFailures.mockReturnValueOnce(
          Effect.succeed({
            ok: true as const,
            checks: [
              {
                name: 'ci / test',
                conclusion: 'failure',
                url: 'https://ci.example.com/run/1',
                details: 'Integration tests are failing',
              },
            ],
          }),
        )
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(publishedMessages.some((message) => message.topic === 'codex-topic')).toBe(false)
        expect(mockBuildCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review', issueNumber: 5 }))
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
      codebase: { ...baseConfig.codebase, ...(configOverride?.codebase ?? {}) },
      github: { ...baseConfig.github, ...(configOverride?.github ?? {}) },
      topics: { ...baseConfig.topics, ...(configOverride?.topics ?? {}) },
      discord: { ...baseConfig.discord, ...(configOverride?.discord ?? {}) },
      flags: configOverride?.flags ?? baseConfig.flags,
    }
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config })

    if (configOverride?.flags) {
      expect(config.flags?.skipPlanningPlaceholder).toBe(configOverride.flags.skipPlanningPlaceholder)
    }

    const response = await handler(buildRequest(payload, scenarioHeaders(event, action)), 'github')

    expect(response.status).toBe(202)
    const body = await response.json()
    await assert(body, response)
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
  })

  it('returns 401 when signature header missing', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const response = await handler(buildRequest({}, {}), 'github')
    expect(response.status).toBe(401)
    expect(publishedMessages).toHaveLength(0)
  })

  it('publishes planning message on issue opened', async () => {
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
    expect(publishedMessages).toHaveLength(3)
    const [planningJsonMessage, planningStructuredMessage, rawJsonMessage] = publishedMessages

    expect(planningJsonMessage).toMatchObject({ topic: 'codex-topic', key: 'issue-1-planning' })
    expect(planningStructuredMessage).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-1-planning',
    })
    expect(planningStructuredMessage.headers?.['content-type']).toBe('application/x-protobuf')

    const planningProto = fromBinary(CodexTaskSchema, toBuffer(planningStructuredMessage.value))
    expect(planningProto.stage).toBe(CodexTaskStage.PLANNING)
    expect(planningProto.repository).toBe('owner/repo')
    expect(planningProto.issueNumber).toBe(BigInt(1))
    expect(planningProto.deliveryId).toBe('delivery-123')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-123' })
    expect(githubServiceMock.postIssueReaction).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: 'owner/repo', issueNumber: 1 }),
    )
  })

  it('publishes implementation message when trigger comment is received', async () => {
    githubServiceMock.findLatestPlanComment.mockReturnValueOnce(
      Effect.succeed({ ok: true, comment: { id: 10, body: 'Plan', htmlUrl: 'https://comment' } }),
    )

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
      comment: { body: 'execute plan' },
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

    expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(3)
    const [implementationJsonMessage, implementationStructuredMessage, rawJsonMessage] = publishedMessages

    expect(implementationJsonMessage).toMatchObject({ topic: 'codex-topic', key: 'issue-2-implementation' })
    expect(implementationStructuredMessage).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-2-implementation',
    })
    expect(implementationStructuredMessage.headers?.['content-type']).toBe('application/x-protobuf')

    const implementationProto = fromBinary(CodexTaskSchema, toBuffer(implementationStructuredMessage.value))
    expect(implementationProto.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(implementationProto.deliveryId).toBe('delivery-999')
    expect(implementationProto.planCommentId).toBe(BigInt(10))
    expect(implementationProto.planCommentBody).toBe('Plan')
    expect(implementationProto.planCommentUrl).toBe('https://comment')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-999' })
  })

  it('publishes implementation message when plan comment marker is present', async () => {
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'created',
      issue: {
        number: 3,
        title: 'Implementation issue',
        body: 'Body',
        html_url: 'https://issue',
      },
      repository: { default_branch: 'main' },
      sender: { login: 'github-actions[bot]' },
      comment: {
        id: 42,
        body: '## Plan\n\n- Do something\n\n<!-- codex:plan -->',
        html_url: 'https://comment/42',
      },
    }

    await handler(
      buildRequest(payload, {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-plan-marker',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(3)
    const [implementationJsonMessage, implementationStructuredMessage, rawJsonMessage] = publishedMessages

    expect(implementationJsonMessage).toMatchObject({ topic: 'codex-topic', key: 'issue-3-implementation' })
    expect(implementationStructuredMessage).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-3-implementation',
    })
    expect(implementationStructuredMessage.headers?.['content-type']).toBe('application/x-protobuf')

    const implementationProto = fromBinary(CodexTaskSchema, toBuffer(implementationStructuredMessage.value))
    expect(implementationProto.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(implementationProto.issueNumber).toBe(BigInt(3))
    expect(implementationProto.planCommentId).toBe(BigInt(42))
    expect(implementationProto.planCommentBody).toContain('<!-- codex:plan -->')
    expect(implementationProto.planCommentUrl).toBe('https://comment/42')
    expect(implementationProto.deliveryId).toBe('delivery-plan-marker')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-plan-marker' })
  })

  describe('review comment trigger', () => {
    it('publishes review message when an authorized collaborator requests review', async () => {
      githubServiceMock.fetchPullRequest.mockReturnValueOnce(
        Effect.succeed({
          ok: true as const,
          pullRequest: {
            number: 5,
            title: 'Review automation',
            body: 'Ensure Codex keeps iterating.',
            htmlUrl: 'https://github.com/owner/repo/pull/5',
            draft: false,
            merged: false,
            state: 'open',
            headRef: 'codex/issue-9-branch',
            headSha: 'abc123',
            baseRef: 'main',
            authorLogin: 'user',
            mergeableState: 'blocked',
          },
        }),
      )

      githubServiceMock.listPullRequestReviewThreads.mockReturnValueOnce(
        Effect.succeed({
          ok: true as const,
          threads: [
            {
              summary: 'Add unit tests for webhook logic',
              url: 'https://github.com/owner/repo/pull/5#discussion_r1',
              author: 'octocat',
            },
          ],
        }),
      )

      githubServiceMock.listPullRequestCheckFailures.mockReturnValueOnce(
        Effect.succeed({
          ok: true as const,
          checks: [
            {
              name: 'ci / test',
              conclusion: 'failure',
              url: 'https://ci.example.com/run/1',
              details: 'Integration tests are failing',
            },
          ],
        }),
      )

      const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
      const payload = {
        action: 'created',
        issue: {
          number: 5,
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/5' },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'maintainer' },
        comment: {
          id: 101,
          body: 'Please @tuslagch review this change.',
          html_url: 'https://github.com/owner/repo/pull/5#issuecomment-101',
          author_association: 'MEMBER',
          updated_at: '2025-10-30T00:00:00Z',
          user: { login: 'maintainer' },
        },
      }

      const response = await handler(
        buildRequest(payload, {
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'delivery-review-comment',
          'x-github-action': 'created',
          'x-hub-signature-256': 'sig',
          'content-type': 'application/json',
        }),
        'github',
      )

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: 'reviewRequested' })

      expect(mockBuildCodexPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'review',
          issueNumber: 9,
          reviewContext: expect.objectContaining({
            reviewThreads: expect.arrayContaining([
              expect.objectContaining({ summary: 'Add unit tests for webhook logic' }),
            ]),
          }),
        }),
      )

      const reviewJsonMessage = publishedMessages.find((message) => message.topic === 'codex-topic')
      const reviewStructuredMessage = publishedMessages.find((message) => message.topic === 'github.issues.codex.tasks')
      expect(reviewJsonMessage).toBeTruthy()
      expect(reviewStructuredMessage).toBeTruthy()
      if (!reviewJsonMessage || !reviewStructuredMessage) {
        throw new Error('expected codex review messages to be published')
      }

      expect(reviewJsonMessage.headers?.['x-codex-review-fingerprint']).toMatch(/^[a-f0-9]{32}$/)
      expect(reviewJsonMessage.headers?.['x-codex-review-head-sha']).toBe('abc123')
      const reviewJsonPayload = JSON.parse(toBuffer(reviewJsonMessage.value).toString('utf8'))
      expect(reviewJsonPayload.stage).toBe('review')
      expect(reviewJsonPayload.issueNumber).toBe(9)
      expect(reviewJsonPayload.reviewContext.failingChecks[0].name).toBe('ci / test')
      expect(reviewJsonPayload.reviewContext.additionalNotes[0]).toContain('mergeable_state=blocked')
      const reviewProto = fromBinary(CodexTaskSchema, toBuffer(reviewStructuredMessage.value))
      expect(reviewProto.stage).toBe(CodexTaskStage.REVIEW)
      expect(reviewProto.issueNumber).toBe(BigInt(9))
    })

    it('ignores @tuslagch review comments from unauthorized authors', async () => {
      const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
      const payload = {
        action: 'created',
        issue: {
          number: 8,
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/8' },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'contributor' },
        comment: {
          id: 204,
          body: '@tuslagch review when ready',
          html_url: 'https://github.com/owner/repo/pull/8#issuecomment-204',
          author_association: 'CONTRIBUTOR',
          updated_at: '2025-10-30T01:00:00Z',
          user: { login: 'contributor' },
        },
      }

      const response = await handler(
        buildRequest(payload, {
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'delivery-review-comment-unauth',
          'x-github-action': 'created',
          'x-hub-signature-256': 'sig',
          'content-type': 'application/json',
        }),
        'github',
      )

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: null })
      expect(publishedMessages).toHaveLength(1)
      expect(publishedMessages[0]).toMatchObject({ topic: 'raw-topic', key: 'delivery-review-comment-unauth' })
      expect(mockBuildCodexPrompt).not.toHaveBeenCalled()
    })

    it('dedupes repeated @tuslagch review comments while allowing edited timestamps to retrigger', async () => {
      githubServiceMock.fetchPullRequest.mockReturnValue(
        Effect.succeed({
          ok: true as const,
          pullRequest: {
            number: 11,
            title: 'Deduplication test',
            body: 'Check comment dedupe.',
            htmlUrl: 'https://github.com/owner/repo/pull/11',
            draft: false,
            merged: false,
            state: 'open',
            headRef: 'codex/issue-11',
            headSha: 'dedupsha',
            baseRef: 'main',
            authorLogin: 'user',
            mergeableState: 'clean',
          },
        }),
      )
      githubServiceMock.listPullRequestReviewThreads.mockReturnValue(Effect.succeed({ ok: true as const, threads: [] }))
      githubServiceMock.listPullRequestCheckFailures.mockReturnValue(Effect.succeed({ ok: true as const, checks: [] }))

      const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
      const basePayload = {
        issue: {
          number: 11,
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/11' },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'maintainer' },
        comment: {
          id: 404,
          body: '@tuslagch review please',
          html_url: 'https://github.com/owner/repo/pull/11#issuecomment-404',
          author_association: 'OWNER',
          updated_at: '2025-10-30T02:00:00Z',
          user: { login: 'maintainer' },
        },
      }

      await handler(
        buildRequest(
          { ...basePayload, action: 'created' },
          {
            'x-github-event': 'issue_comment',
            'x-github-delivery': 'review-dedupe-1',
            'x-github-action': 'created',
            'x-hub-signature-256': 'sig',
            'content-type': 'application/json',
          },
        ),
        'github',
      )
      expect(publishedMessages.some((message) => message.topic === 'codex-topic')).toBe(true)

      publishedMessages = []

      await handler(
        buildRequest(
          { ...basePayload, action: 'created' },
          {
            'x-github-event': 'issue_comment',
            'x-github-delivery': 'review-dedupe-2',
            'x-github-action': 'created',
            'x-hub-signature-256': 'sig',
            'content-type': 'application/json',
          },
        ),
        'github',
      )
      expect(publishedMessages).toHaveLength(1)
      expect(publishedMessages[0]).toMatchObject({ topic: 'raw-topic', key: 'review-dedupe-2' })

      publishedMessages = []

      await handler(
        buildRequest(
          {
            ...basePayload,
            action: 'edited',
            comment: { ...basePayload.comment, updated_at: '2025-10-30T02:05:00Z' },
          },
          {
            'x-github-event': 'issue_comment',
            'x-github-delivery': 'review-dedupe-3',
            'x-github-action': 'edited',
            'x-hub-signature-256': 'sig',
            'content-type': 'application/json',
          },
        ),
        'github',
      )
      expect(publishedMessages.some((message) => message.topic === 'codex-topic')).toBe(true)
    })
  })

  it('does not publish review messages for pull request events without explicit comment trigger', async () => {
    githubServiceMock.fetchPullRequest.mockReturnValueOnce(
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 7,
          title: 'Fresh PR',
          body: 'Initial change set',
          htmlUrl: 'https://github.com/owner/repo/pull/7',
          draft: false,
          merged: false,
          state: 'open',
          headRef: 'codex/issue-7-fresh',
          headSha: 'ghi789',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'opened',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'user' },
      pull_request: {
        number: 7,
        head: { ref: 'codex/issue-7-fresh', sha: 'ghi789' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-review-opened',
        'x-github-action': 'opened',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: null })
    expect(publishedMessages).toHaveLength(1)
    expect(publishedMessages[0]).toMatchObject({ topic: 'raw-topic', key: 'delivery-review-opened' })
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
    expect(publishedMessages[0]).toMatchObject({
      topic: 'raw-topic',
      key: 'delivery-review-clean-update',
    })
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

  it('publishes review message when merge conflicts are detected', async () => {
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
    expect(publishedMessages.some((message) => message.topic === 'codex-topic')).toBe(false)
  })

  it('converts draft Codex pull requests to ready-for-review when clean', async () => {
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
    expect(githubServiceMock.markPullRequestReadyForReview).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: 'owner/repo', pullNumber: 6 }),
    )
    expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: 'owner/repo', pullNumber: 6, body: '@codex review' }),
    )
    expect(publishedMessages).toHaveLength(1)
    expect(publishedMessages[0]).toMatchObject({ topic: 'raw-topic', key: 'delivery-undraft-1' })
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
  })

  it('returns plan modal response for slash command', async () => {
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

    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload).toEqual({
      type: 9,
      data: {
        custom_id: 'plan:cmd-1',
        title: 'Request Planning Run',
        components: [],
      },
    })
  })

  it('publishes plan modal submissions and returns acknowledgement', async () => {
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

    const [discordMessage] = publishedMessages
    expect(discordMessage).toMatchObject({ topic: 'discord-topic', key: 'interaction-123' })
    expect(discordMessage.headers['content-type']).toBe('application/x-protobuf')

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
    expect(parsedPayload.stage).toBe('planning')
    expect(parsedPayload.runId).toBe('interaction-123')

    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload).toEqual({
      type: 4,
      data: {
        content: 'Planning request received. Facteur will execute the workflow shortly.',
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
    const payload = await response.json()
    expect(payload).toEqual({ type: 1 })
  })
})
