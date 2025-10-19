import { Effect, Layer } from 'effect'
import { type ManagedRuntime, make as makeManagedRuntime } from 'effect/ManagedRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppLogger } from '@/logger'
import { CommandEvent as FacteurCommandEventMessage } from '@/proto/facteur/v1/contract_pb'
import { CodexTask, CodexTaskStage } from '@/proto/github/v1/codex_task_pb'
import { createWebhookHandler, type WebhookConfig } from '@/routes/webhooks'
import { GithubService } from '@/services/github'
import { type KafkaMessage, KafkaProducer } from '@/services/kafka'

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

vi.mock('@/codex', () => ({
  buildCodexBranchName: vi.fn(() => 'codex/issue-1-test'),
  buildCodexPrompt: mockBuildCodexPrompt,
  normalizeLogin: vi.fn((value: string | undefined | null) => (value ? value.toLowerCase() : null)),
}))

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
    findLatestPlanComment: ReturnType<typeof vi.fn>
    fetchPullRequest: ReturnType<typeof vi.fn>
    markPullRequestReadyForReview: ReturnType<typeof vi.fn>
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
      findLatestPlanComment: githubServiceMock.findLatestPlanComment,
      fetchPullRequest: githubServiceMock.fetchPullRequest,
      markPullRequestReadyForReview: githubServiceMock.markPullRequestReadyForReview,
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
      findLatestPlanComment: vi.fn(() => Effect.succeed({ ok: false, reason: 'not-found' })),
      fetchPullRequest: vi.fn(() => Effect.succeed({ ok: false as const, reason: 'not-found' as const })),
      markPullRequestReadyForReview: vi.fn(() => Effect.succeed({ ok: true })),
      createPullRequestComment: vi.fn(() => Effect.succeed({ ok: true })),
      listPullRequestReviewThreads: vi.fn(() => Effect.succeed({ ok: true as const, threads: [] })),
      listPullRequestCheckFailures: vi.fn(() => Effect.succeed({ ok: true as const, checks: [] })),
    }
    provideRuntime()
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
    assert: (body: any, response: Response) => Promise<void> | void
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
      name: 'requests Codex review when outstanding feedback exists',
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
        expect(body).toMatchObject({ codexStageTriggered: 'review' })
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
      },
      assert: (body) => {
        expect(body).toMatchObject({ codexStageTriggered: null })
        expect(githubServiceMock.findLatestPlanComment).toHaveBeenCalled()
        expect(githubServiceMock.createPullRequestComment).toHaveBeenCalledWith(
          expect.objectContaining({ body: expect.stringContaining('ready to merge') }),
        )
      },
    },
  ]

  it.each(webhookScenarios)('$name', async ({ event, action, payload, setup, assert }) => {
    setup?.()
    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })

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

    const planningProto = CodexTask.fromBinary(toBuffer(planningStructuredMessage.value))
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

    const implementationProto = CodexTask.fromBinary(toBuffer(implementationStructuredMessage.value))
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

    const implementationProto = CodexTask.fromBinary(toBuffer(implementationStructuredMessage.value))
    expect(implementationProto.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(implementationProto.issueNumber).toBe(BigInt(3))
    expect(implementationProto.planCommentId).toBe(BigInt(42))
    expect(implementationProto.planCommentBody).toContain('<!-- codex:plan -->')
    expect(implementationProto.planCommentUrl).toBe('https://comment/42')
    expect(implementationProto.deliveryId).toBe('delivery-plan-marker')

    expect(rawJsonMessage).toMatchObject({ topic: 'raw-topic', key: 'delivery-plan-marker' })
  })

  it('publishes review message when a Codex pull request has outstanding feedback', async () => {
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

    const handler = createWebhookHandler({ runtime, webhooks: webhooks as never, config: baseConfig })
    const payload = {
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      sender: { login: 'reviewer' },
      pull_request: {
        number: 5,
        head: { ref: 'codex/issue-5-branch', sha: 'abc123' },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } },
        user: { login: 'USER' },
      },
    }

    const response = await handler(
      buildRequest(payload, {
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'delivery-review-1',
        'x-github-action': 'submitted',
        'x-hub-signature-256': 'sig',
        'content-type': 'application/json',
      }),
      'github',
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: 'review' })

    expect(githubServiceMock.fetchPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: 'owner/repo', pullNumber: 5 }),
    )
    expect(githubServiceMock.markPullRequestReadyForReview).not.toHaveBeenCalled()
    expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
    expect(mockBuildCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'review',
        reviewContext: expect.objectContaining({
          reviewThreads: expect.arrayContaining([
            expect.objectContaining({ summary: 'Add unit tests for webhook logic' }),
          ]),
        }),
      }),
    )

    expect(publishedMessages).toHaveLength(3)
    const reviewJsonMessage = publishedMessages.find((message) => message.topic === 'codex-topic')
    expect(reviewJsonMessage).toBeTruthy()
    if (!reviewJsonMessage) {
      throw new Error('Expected review JSON message to be published')
    }
    const reviewStructuredMessage = publishedMessages.find((message) => message.topic === 'github.issues.codex.tasks')
    expect(reviewStructuredMessage).toBeTruthy()
    if (!reviewStructuredMessage) {
      throw new Error('Expected review structured message to be published')
    }

    const reviewJsonPayload = JSON.parse(toBuffer(reviewJsonMessage.value).toString('utf8'))
    expect(reviewJsonPayload.stage).toBe('review')
    expect(reviewJsonPayload.reviewContext.reviewThreads[0].summary).toBe('Add unit tests for webhook logic')
    expect(reviewJsonPayload.reviewContext.failingChecks[0].name).toBe('ci / test')
    expect(reviewJsonPayload.reviewContext.additionalNotes[0]).toContain('mergeable_state=blocked')
    expect(reviewJsonPayload.issueNumber).toBe(5)

    const reviewProto = CodexTask.fromBinary(toBuffer(reviewStructuredMessage.value))
    expect(reviewProto.stage).toBe(CodexTaskStage.REVIEW)
    expect(reviewProto.issueNumber).toBe(BigInt(5))
    expect(reviewProto.reviewContext?.reviewThreads[0]?.summary).toBe('Add unit tests for webhook logic')
    expect(reviewProto.reviewContext?.failingChecks[0]?.name).toBe('ci / test')
    expect(reviewProto.reviewContext?.additionalNotes[0]).toContain('mergeable_state=blocked')
  })

  it('publishes review message and skips ready comment when a Codex pull request opens cleanly', async () => {
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
    await expect(response.json()).resolves.toMatchObject({ codexStageTriggered: 'review' })

    expect(githubServiceMock.markPullRequestReadyForReview).not.toHaveBeenCalled()
    expect(githubServiceMock.findLatestPlanComment).not.toHaveBeenCalled()
    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()
    expect(mockBuildCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'review',
        repositoryFullName: 'owner/repo',
        issueNumber: 7,
      }),
    )

    expect(publishedMessages).toHaveLength(3)
    const reviewJsonMessage = publishedMessages.find((message) => message.topic === 'codex-topic')
    expect(reviewJsonMessage).toBeTruthy()
    const reviewStructuredMessage = publishedMessages.find((message) => message.topic === 'github.issues.codex.tasks')
    expect(reviewStructuredMessage).toBeTruthy()
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
        body: expect.stringContaining('ready to merge'),
      }),
    )
    expect(mockBuildCodexPrompt).not.toHaveBeenCalled()
    expect(publishedMessages).toHaveLength(1)
    expect(publishedMessages[0]).toMatchObject({
      topic: 'raw-topic',
      key: 'delivery-review-clean-update',
    })
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
    expect(body).toMatchObject({ codexStageTriggered: 'review' })

    expect(githubServiceMock.createPullRequestComment).not.toHaveBeenCalled()

    const reviewJsonMessage = publishedMessages.find((message) => message.topic === 'codex-topic')
    expect(reviewJsonMessage).toBeTruthy()
    if (!reviewJsonMessage) {
      throw new Error('Expected review JSON message to be published')
    }
    const reviewJsonPayload = JSON.parse(toBuffer(reviewJsonMessage.value).toString('utf8'))
    expect(reviewJsonPayload.reviewContext.summary).toBe('Outstanding items: merge conflicts detected.')
    expect(reviewJsonPayload.reviewContext.additionalNotes).toEqual(
      expect.arrayContaining([
        'GitHub reports mergeable_state=dirty.',
        'Resolve merge conflicts with the base branch before retrying.',
      ]),
    )
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
    expect(mockBuildCodexPrompt).not.toHaveBeenCalled()
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

    const protoEvent = FacteurCommandEventMessage.fromBinary(toBuffer(discordMessage.value))
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
