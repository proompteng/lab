import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearReviewFingerprintCacheForTest } from '../../review-fingerprint'
import type { WebhookConfig } from '../../types'
import type { WorkflowExecutionContext } from '../../workflow'
import * as workflowModule from '../../workflow'
import { handleReviewComment } from '../pull-request-comment'

const mockedExecuteWorkflowCommands = vi.spyOn(workflowModule, 'executeWorkflowCommands')

const baseConfig = {
  github: {
    token: 'token',
    apiBaseUrl: 'https://api.github.com',
    userAgent: 'codex-test',
  },
  topics: {
    codex: 'codex-topic',
    codexStructured: 'codex-structured-topic',
  },
}

const headers = {
  'x-github-delivery': 'delivery-id',
  'x-github-event': 'issue_comment',
}

const buildConfig = (): WebhookConfig => ({
  codebase: { branchPrefix: 'codex/issue-', baseBranch: 'main' },
  github: {
    token: baseConfig.github.token,
    ackReaction: '+1',
    apiBaseUrl: baseConfig.github.apiBaseUrl,
    userAgent: baseConfig.github.userAgent,
  },
  codexTriggerLogin: 'user',
  codexWorkflowLogin: 'bot',
  codexImplementationTriggerPhrase: 'execute plan',
  topics: {
    raw: 'raw-topic',
    codex: baseConfig.topics.codex,
    codexStructured: baseConfig.topics.codexStructured,
    discordCommands: 'discord-commands',
  },
  discord: {
    publicKey: 'test-key',
    response: {
      applicationId: 'app',
      commandId: 'cmd',
      endpoint: 'https://example.com',
    },
  },
})

const buildExecutionContext = () => {
  const fetchPullRequest = vi.fn(() =>
    Effect.succeed({
      ok: true as const,
      pullRequest: {
        number: 42,
        title: 'Test PR',
        body: 'Body',
        htmlUrl: 'https://github.com/owner/repo/pull/42',
        draft: false,
        merged: false,
        state: 'open',
        headRef: 'codex/issue-42-branch',
        headSha: 'abcdef',
        baseRef: 'main',
        authorLogin: 'user',
        mergeableState: 'clean',
      },
    }),
  )

  const listPullRequestReviewThreads = vi.fn(() =>
    Effect.succeed({
      ok: true as const,
      threads: [],
    }),
  )

  const listPullRequestCheckFailures = vi.fn(() =>
    Effect.succeed({
      ok: true as const,
      checks: [],
    }),
  )

  const executionContext: WorkflowExecutionContext = {
    runtime: null as unknown as WorkflowExecutionContext['runtime'],
    githubService: {
      fetchPullRequest,
      listPullRequestReviewThreads,
      listPullRequestCheckFailures,
    } as WorkflowExecutionContext['githubService'],
    runGithub: <A>(factory: () => Effect.Effect<never, never, A>) => Effect.runPromise(factory()),
    config: baseConfig,
    deliveryId: 'delivery-id',
    workflowIdentifier: null,
  }

  return { executionContext, fetchPullRequest, listPullRequestReviewThreads, listPullRequestCheckFailures }
}

beforeEach(() => {
  mockedExecuteWorkflowCommands.mockResolvedValue({ stage: 'reviewRequested' })
  mockedExecuteWorkflowCommands.mockClear()
  clearReviewFingerprintCacheForTest()
})

afterEach(() => {
  mockedExecuteWorkflowCommands.mockReset()
})

describe('handleReviewComment', () => {
  it('returns handled=false when the payload is not a pull request comment', async () => {
    const { executionContext, fetchPullRequest } = buildExecutionContext()
    const config = buildConfig()
    const result = await handleReviewComment({
      parsedPayload: {
        action: 'created',
        issue: { number: 1 },
        repository: { full_name: 'owner/repo' },
        comment: { id: 1, body: 'hello world' },
      },
      headers,
      config,
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'user',
      actionValue: 'created',
    })

    expect(result).toEqual({ handled: false, stage: null })
    expect(fetchPullRequest).not.toHaveBeenCalled()
    expect(mockedExecuteWorkflowCommands).not.toHaveBeenCalled()
  })

  it('ignores unauthorized review comments', async () => {
    const { executionContext, fetchPullRequest } = buildExecutionContext()
    const result = await handleReviewComment({
      parsedPayload: {
        action: 'created',
        issue: {
          number: 42,
          pull_request: {
            url: 'https://api.github.com/repos/owner/repo/pulls/42',
            html_url: 'https://github.com/owner/repo/pull/42',
          },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        comment: {
          id: 10,
          body: '@tuslagch review please',
          author_association: 'CONTRIBUTOR',
          updated_at: '2025-10-30T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/42#issuecomment-10',
          user: { login: 'contributor' },
        },
        sender: { login: 'contributor' },
      },
      headers,
      config: buildConfig(),
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'user',
      actionValue: 'created',
    })

    expect(result).toEqual({ handled: false, stage: null })
    expect(fetchPullRequest).not.toHaveBeenCalled()
    expect(mockedExecuteWorkflowCommands).not.toHaveBeenCalled()
  })

  it('publishes review commands for authorized @tuslagch review comments', async () => {
    const { executionContext, fetchPullRequest, listPullRequestReviewThreads, listPullRequestCheckFailures } =
      buildExecutionContext()

    const result = await handleReviewComment({
      parsedPayload: {
        action: 'created',
        issue: {
          number: 42,
          pull_request: {
            url: 'https://api.github.com/repos/owner/repo/pulls/42',
            html_url: 'https://github.com/owner/repo/pull/42',
          },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        comment: {
          id: 10,
          body: '@tuslagch review please',
          author_association: 'MEMBER',
          updated_at: '2025-10-30T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/42#issuecomment-10',
          user: { login: 'maintainer' },
        },
        sender: { login: 'maintainer' },
      },
      headers,
      config: buildConfig(),
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'user',
      actionValue: 'created',
    })

    expect(result).toEqual({ handled: true, stage: 'reviewRequested' })
    expect(fetchPullRequest).toHaveBeenCalled()
    expect(listPullRequestReviewThreads).toHaveBeenCalled()
    expect(listPullRequestCheckFailures).toHaveBeenCalled()
    expect(mockedExecuteWorkflowCommands).toHaveBeenCalledTimes(1)
    const [commands] = mockedExecuteWorkflowCommands.mock.calls[0]
    expect(commands).toEqual([{ type: 'publishReview', data: expect.objectContaining({ stage: 'review' }) }])
  })

  it('skips review publishing when the issue number cannot be derived from the pull request branch', async () => {
    const { executionContext, fetchPullRequest, listPullRequestReviewThreads, listPullRequestCheckFailures } =
      buildExecutionContext()

    fetchPullRequest.mockImplementationOnce(() =>
      Effect.succeed({
        ok: true as const,
        pullRequest: {
          number: 17,
          title: 'Branch without issue id',
          body: 'Missing codex issue reference',
          htmlUrl: 'https://github.com/owner/repo/pull/17',
          draft: false,
          merged: false,
          state: 'open',
          headRef: 'feature/no-issue-id',
          headSha: 'deadbe',
          baseRef: 'main',
          authorLogin: 'user',
          mergeableState: 'clean',
        },
      }),
    )

    const result = await handleReviewComment({
      parsedPayload: {
        action: 'created',
        issue: {
          number: 17,
          pull_request: {
            url: 'https://api.github.com/repos/owner/repo/pulls/17',
            html_url: 'https://github.com/owner/repo/pull/17',
          },
          repository_url: 'https://api.github.com/repos/owner/repo',
        },
        repository: { full_name: 'owner/repo', default_branch: 'main' },
        comment: {
          id: 77,
          body: '@tuslagch review please',
          author_association: 'MEMBER',
          updated_at: '2025-10-30T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/17#issuecomment-77',
          user: { login: 'maintainer' },
        },
        sender: { login: 'maintainer' },
      },
      headers,
      config: buildConfig(),
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'maintainer',
      actionValue: 'created',
    })

    expect(result).toEqual({ handled: true, stage: null })
    expect(fetchPullRequest).toHaveBeenCalled()
    expect(listPullRequestReviewThreads).not.toHaveBeenCalled()
    expect(listPullRequestCheckFailures).not.toHaveBeenCalled()
    expect(mockedExecuteWorkflowCommands).not.toHaveBeenCalled()
  })

  it('dedupes repeated review comments with identical timestamps', async () => {
    const { executionContext } = buildExecutionContext()

    const config = buildConfig()

    const payload = {
      action: 'created',
      issue: {
        number: 42,
        pull_request: {
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          html_url: 'https://github.com/owner/repo/pull/42',
        },
        repository_url: 'https://api.github.com/repos/owner/repo',
      },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      comment: {
        id: 555,
        body: '@tuslagch review please',
        author_association: 'OWNER',
        updated_at: '2025-10-30T00:00:00Z',
        html_url: 'https://github.com/owner/repo/pull/42#issuecomment-555',
        user: { login: 'maintainer' },
      },
      sender: { login: 'maintainer' },
    }

    await handleReviewComment({
      parsedPayload: payload,
      headers,
      config,
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'owner',
      actionValue: 'created',
    })
    expect(mockedExecuteWorkflowCommands).toHaveBeenCalledTimes(1)

    const second = await handleReviewComment({
      parsedPayload: payload,
      headers,
      config,
      executionContext,
      deliveryId: 'delivery-id',
      senderLogin: 'owner',
      actionValue: 'created',
    })
    expect(second).toEqual({ handled: true, stage: null })
    expect(mockedExecuteWorkflowCommands).toHaveBeenCalledTimes(1)
  })
})
