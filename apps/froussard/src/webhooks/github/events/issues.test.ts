import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImplementationCommand } from '@/codex/workflow-machine'
import type { AppRuntime } from '@/effect/runtime'
import { CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import type { GithubServiceDefinition } from '@/services/github/service.types'
import type { WebhookConfig } from '@/webhooks/types'
import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from '../constants'
import type { WorkflowExecutionContext } from '../workflow'
import { handleIssueCommentCreated, handleIssueOpened } from './issues'

const { mockExecuteWorkflowCommands } = vi.hoisted(() => ({
  mockExecuteWorkflowCommands: vi.fn(async () => ({ stage: 'implementation' as const })),
}))

vi.mock('../workflow', () => ({
  executeWorkflowCommands: mockExecuteWorkflowCommands,
}))

describe('handleIssueOpened', () => {
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
      codexStructured: 'codex-structured-topic',
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

  const buildExecutionContext = (): WorkflowExecutionContext => ({
    runtime: { runPromise: vi.fn(async () => undefined) } as AppRuntime,
    githubService: {} as GithubServiceDefinition,
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
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-10-09T00:00:00.000Z'))
    mockExecuteWorkflowCommands.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds and queues an implementation command payload', async () => {
    const parsedPayload = {
      issue: {
        number: 42,
        title: 'Implement feature',
        body: 'Detailed description',
        html_url: 'https://github.com/owner/repo/issues/42',
        repository_url: 'https://api.github.com/repos/owner/repo',
        user: { login: 'USER' },
      },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      sender: { login: 'sender' },
    }

    const stage = await handleIssueOpened({
      parsedPayload,
      headers: { 'x-request-id': 'req-1' },
      config: baseConfig,
      executionContext: buildExecutionContext(),
      deliveryId: 'delivery-123',
    })

    expect(stage).toBe('implementation')
    expect(mockExecuteWorkflowCommands).toHaveBeenCalledTimes(1)

    const [commands] = mockExecuteWorkflowCommands.mock.calls[0] ?? []
    const command = commands?.[0]
    if (!command || command.type !== 'publishImplementation') {
      throw new Error('Expected publishImplementation command')
    }

    const data = command.data as ImplementationCommand

    expect(data.key).toBe('issue-42-implementation')
    expect(data.topics).toEqual({
      codex: 'codex-topic',
      codexStructured: 'codex-structured-topic',
    })
    expect(data.codexMessage).toMatchObject({
      stage: 'implementation',
      repository: 'owner/repo',
      base: 'main',
      head: 'codex/issue-42-delivery',
      issueNumber: 42,
      issueUrl: 'https://github.com/owner/repo/issues/42',
      issueTitle: 'Implement feature',
      issueBody: 'Detailed description',
      sender: 'sender',
      issuedAt: '2025-10-09T00:00:00.000Z',
    })
    expect(data.codexMessage.prompt).toContain('Implement this issue end to end.')
    expect(data.codexMessage.prompt).toContain('Issue: #42 - Implement feature')
    expect(data.structuredMessage.deliveryId).toBe('delivery-123')
    expect(data.structuredMessage.issueNumber).toBe(42n)
    expect(data.structuredMessage.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(data.jsonHeaders).toMatchObject({
      'x-request-id': 'req-1',
      'x-codex-task-stage': 'implementation',
    })
    expect(data.structuredHeaders).toMatchObject({
      'x-request-id': 'req-1',
      'x-codex-task-stage': 'implementation',
      'content-type': PROTO_CONTENT_TYPE,
      'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
      'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
    })
  })

  it('rejects malformed payloads without publishing', async () => {
    const parsedPayload = {
      issue: {
        title: 'Missing number',
        repository_url: 'https://api.github.com/repos/owner/repo',
        user: { login: 'user' },
      },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
      sender: { login: 'user' },
    }

    const stage = await handleIssueOpened({
      parsedPayload,
      headers: { 'x-request-id': 'req-2' },
      config: baseConfig,
      executionContext: buildExecutionContext(),
      deliveryId: 'delivery-123',
    })

    expect(stage).toBeNull()
    expect(mockExecuteWorkflowCommands).not.toHaveBeenCalled()
  })
})

describe('handleIssueCommentCreated', () => {
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
      codexStructured: 'codex-structured-topic',
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

  const buildExecutionContext = (): WorkflowExecutionContext => ({
    runtime: { runPromise: vi.fn(async () => undefined) } as AppRuntime,
    githubService: {} as GithubServiceDefinition,
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
    deliveryId: 'delivery-999',
    workflowIdentifier: null,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-10-09T01:00:00.000Z'))
    mockExecuteWorkflowCommands.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues implementation publish on trigger comment', async () => {
    const parsedPayload = {
      issue: {
        number: 7,
        title: 'Ship it',
        body: 'Ship details',
        html_url: 'https://github.com/owner/repo/issues/7',
        repository_url: 'https://api.github.com/repos/owner/repo',
      },
      comment: {
        id: 1,
        body: 'implement issue',
      },
      sender: { login: 'user' },
      repository: { full_name: 'owner/repo', default_branch: 'main' },
    }

    const stage = await handleIssueCommentCreated({
      parsedPayload,
      headers: { 'x-request-id': 'req-3' },
      config: baseConfig,
      executionContext: buildExecutionContext(),
      deliveryId: 'delivery-999',
    })

    expect(stage).toBe('implementation')
    expect(mockExecuteWorkflowCommands).toHaveBeenCalledTimes(1)

    const [commands] = mockExecuteWorkflowCommands.mock.calls[0] ?? []
    const command = commands?.[0]
    if (!command || command.type !== 'publishImplementation') {
      throw new Error('Expected publishImplementation command')
    }

    const data = command.data as ImplementationCommand
    expect(data.key).toBe('issue-7-implementation')
    expect(data.codexMessage).toMatchObject({
      repository: 'owner/repo',
      issueNumber: 7,
      sender: 'user',
      issuedAt: '2025-10-09T01:00:00.000Z',
    })
  })
})
