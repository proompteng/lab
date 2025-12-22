import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppRuntime } from '@/effect/runtime'
import { CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import type { WebhookConfig } from '@/webhooks/types'

import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from '../constants'
import type { WorkflowExecutionContext } from '../workflow'
import { executeWorkflowCommands } from '../workflow'
import { handleIssueCommentCreated, handleIssueOpened } from './issues'

const { executeWorkflowCommandsMock } = vi.hoisted(() => ({
  executeWorkflowCommandsMock: vi.fn(),
}))

vi.mock('../workflow', () => ({
  executeWorkflowCommands: executeWorkflowCommandsMock,
}))

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
  codexTriggerLogins: ['user'],
  codexWorkflowLogin: 'github-actions[bot]',
  codexImplementationTriggerPhrase: 'implement issue',
  topics: {
    raw: 'raw-topic',
    codex: 'codex-topic',
    codexStructured: 'github.issues.codex.tasks',
    discordCommands: 'discord-topic',
  },
  discord: {
    publicKey: 'public',
    response: {
      deferType: 'channel-message',
      ephemeral: true,
    },
  },
}

const baseExecutionContext: WorkflowExecutionContext = {
  runtime: { runPromise: Effect.runPromise } as AppRuntime,
  githubService: {} as WorkflowExecutionContext['githubService'],
  runGithub: vi.fn(),
  config: {
    github: {
      token: baseConfig.github.token,
      apiBaseUrl: baseConfig.github.apiBaseUrl,
      userAgent: baseConfig.github.userAgent,
    },
    topics: {
      codex: baseConfig.topics.codex,
      codexStructured: baseConfig.topics.codexStructured,
    },
  },
  deliveryId: 'delivery-123',
  workflowIdentifier: null,
}

const baseHeaders = {
  'x-request-id': 'req-1',
  'content-type': 'application/json',
}

describe('handleIssueOpened', () => {
  const executeMock = vi.mocked(executeWorkflowCommands)

  beforeEach(() => {
    executeMock.mockResolvedValue({ stage: 'implementation' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-22T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('constructs the implementation task command for issue opened', async () => {
    const payload = {
      issue: {
        number: 42,
        title: 'Add tests',
        body: 'Ship it',
        html_url: 'https://github.com/owner/repo/issues/42',
        repository_url: 'https://api.github.com/repos/owner/repo',
        user: { login: 'USER' },
      },
      repository: {
        full_name: 'owner/repo',
        default_branch: 'main',
      },
      sender: { login: 'USER' },
    }

    const result = await handleIssueOpened({
      parsedPayload: payload,
      headers: baseHeaders,
      config: baseConfig,
      executionContext: baseExecutionContext,
      deliveryId: 'delivery-123',
      senderLogin: 'USER',
    })

    expect(result).toBe('implementation')
    expect(executeMock).toHaveBeenCalledTimes(1)

    const [commands] = executeMock.mock.calls[0] ?? []
    expect(commands).toHaveLength(1)
    const command = commands?.[0]
    expect(command?.type).toBe('publishImplementation')
    expect(command?.data.key).toBe('issue-42-implementation')
    expect(command?.data.topics).toEqual({
      codex: baseConfig.topics.codex,
      codexStructured: baseConfig.topics.codexStructured,
    })
    expect(command?.data.jsonHeaders).toMatchObject({
      'x-request-id': 'req-1',
      'content-type': 'application/json',
      'x-codex-task-stage': 'implementation',
    })
    expect(command?.data.structuredHeaders).toMatchObject({
      'x-request-id': 'req-1',
      'content-type': PROTO_CONTENT_TYPE,
      'x-codex-task-stage': 'implementation',
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    })

    expect(command?.data.codexMessage).toMatchObject({
      stage: 'implementation',
      repository: 'owner/repo',
      base: 'main',
      head: 'codex/issue-42-delivery',
      issueNumber: 42,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      issueTitle: 'Add tests',
      issueBody: 'Ship it',
      sender: 'USER',
      issuedAt: '2025-12-22T12:00:00.000Z',
    })
    expect(command?.data.codexMessage.prompt).toContain('Implement this issue end to end.')
    expect(command?.data.codexMessage.prompt).toContain('Issue: #42 - Add tests')

    expect(command?.data.structuredMessage).toMatchObject({
      stage: CodexTaskStage.IMPLEMENTATION,
      repository: 'owner/repo',
      issueNumber: BigInt(42),
      deliveryId: 'delivery-123',
    })
  })

  it('returns null when the issue payload is malformed', async () => {
    const payload = {
      issue: {
        title: 'Missing number',
        user: { login: 'USER' },
      },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'USER' },
    }

    const result = await handleIssueOpened({
      parsedPayload: payload,
      headers: baseHeaders,
      config: baseConfig,
      executionContext: baseExecutionContext,
      deliveryId: 'delivery-123',
    })

    expect(result).toBeNull()
    expect(executeMock).not.toHaveBeenCalled()
  })
})

describe('handleIssueCommentCreated', () => {
  const executeMock = vi.mocked(executeWorkflowCommands)

  beforeEach(() => {
    executeMock.mockResolvedValue({ stage: 'implementation' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-12-22T14:30:00.000Z'))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('constructs the implementation task command for manual trigger comments', async () => {
    const payload = {
      issue: {
        number: 7,
        title: 'Manual run',
        body: 'Please implement',
        html_url: 'https://github.com/owner/repo/issues/7',
      },
      repository: {
        full_name: 'owner/repo',
        default_branch: 'main',
      },
      sender: { login: 'USER' },
      comment: {
        body: 'implement issue',
      },
    }

    const result = await handleIssueCommentCreated({
      parsedPayload: payload,
      headers: baseHeaders,
      config: baseConfig,
      executionContext: baseExecutionContext,
      deliveryId: 'delivery-456',
    })

    expect(result).toBe('implementation')
    expect(executeMock).toHaveBeenCalledTimes(1)

    const [commands] = executeMock.mock.calls[0] ?? []
    expect(commands).toHaveLength(1)
    const command = commands?.[0]
    expect(command?.type).toBe('publishImplementation')
    expect(command?.data.key).toBe('issue-7-implementation')
    expect(command?.data.codexMessage).toMatchObject({
      stage: 'implementation',
      repository: 'owner/repo',
      base: 'main',
      head: 'codex/issue-7-delivery',
      issueNumber: 7,
      sender: 'USER',
      issuedAt: '2025-12-22T14:30:00.000Z',
    })
  })

  it('returns null when the comment payload is malformed', async () => {
    const payload = {
      issue: {
        title: 'Missing number',
      },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'USER' },
      comment: { body: 'implement issue' },
    }

    const result = await handleIssueCommentCreated({
      parsedPayload: payload,
      headers: baseHeaders,
      config: baseConfig,
      executionContext: baseExecutionContext,
      deliveryId: 'delivery-456',
    })

    expect(result).toBeNull()
    expect(executeMock).not.toHaveBeenCalled()
  })
})
