import { fromBinary } from '@bufbuild/protobuf'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { CodexTaskMessage } from '@/codex'
import type { WorkflowCommand } from '@/codex/workflow-machine'
import type { AppRuntime } from '@/effect/runtime'
import { CodexTaskSchema, CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import type { GithubServiceDefinition } from '@/services/github/service.types'

import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from './constants'
import { toCodexTaskProto } from './payloads'
import type { WorkflowExecutionContext } from './workflow'
import { executeWorkflowCommands } from './workflow'

const { publishKafkaMessageMock } = vi.hoisted(() => ({
  publishKafkaMessageMock: vi.fn(() => Effect.succeed(undefined)),
}))

vi.mock('@/webhooks/utils', () => ({
  publishKafkaMessage: publishKafkaMessageMock,
}))

const toBuffer = (value: Uint8Array | Buffer | string) => {
  if (Buffer.isBuffer(value)) {
    return value
  }
  if (typeof value === 'string') {
    return Buffer.from(value)
  }
  return Buffer.from(value)
}

describe('executeWorkflowCommands', () => {
  const baseContext = (runtime: AppRuntime): WorkflowExecutionContext => ({
    runtime,
    githubService: {} as GithubServiceDefinition,
    runGithub: vi.fn(),
    config: {
      github: {
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        userAgent: 'froussard',
      },
      topics: {
        codex: 'codex-topic',
        codexStructured: 'codex-structured-topic',
      },
    },
    deliveryId: 'delivery-123',
    workflowIdentifier: null,
  })

  const codexMessage: CodexTaskMessage = {
    stage: 'implementation',
    prompt: 'PROMPT',
    repository: 'owner/repo',
    base: 'main',
    head: 'codex/issue-1-delivery',
    issueNumber: 1,
    issueUrl: 'https://github.com/owner/repo/issues/1',
    issueTitle: 'Implement feature',
    issueBody: 'Details',
    sender: 'user',
    issuedAt: '2025-10-09T00:00:00.000Z',
  }

  const structuredMessage = toCodexTaskProto(codexMessage, 'delivery-123')

  const publishCommand: WorkflowCommand = {
    type: 'publishImplementation',
    data: {
      stage: 'implementation',
      key: 'issue-1-implementation',
      codexMessage,
      structuredMessage,
      topics: {
        codex: 'codex-topic',
        codexStructured: 'codex-structured-topic',
      },
      jsonHeaders: {
        'x-request-id': 'req-1',
        'x-ignore-me': 123,
      },
      structuredHeaders: {
        'x-request-id': 'req-1',
        'x-ignore-me': false,
      },
    },
  }

  it('publishes implementation messages to both Kafka topics', async () => {
    publishKafkaMessageMock.mockClear()
    const runtime = { runPromise: vi.fn(async () => undefined) } as AppRuntime

    const result = await executeWorkflowCommands([publishCommand], baseContext(runtime))

    expect(result).toEqual({ stage: 'implementation' })
    expect(publishKafkaMessageMock).toHaveBeenCalledTimes(2)

    const [jsonPublish] = publishKafkaMessageMock.mock.calls[0] ?? []
    const [structuredPublish] = publishKafkaMessageMock.mock.calls[1] ?? []

    expect(jsonPublish).toMatchObject({
      topic: 'codex-topic',
      key: 'issue-1-implementation',
      value: JSON.stringify(codexMessage),
      headers: {
        'x-request-id': 'req-1',
        'x-codex-task-stage': 'implementation',
      },
    })

    expect(structuredPublish).toMatchObject({
      topic: 'codex-structured-topic',
      key: 'issue-1-implementation',
      headers: {
        'x-request-id': 'req-1',
        'x-codex-task-stage': 'implementation',
        'content-type': PROTO_CONTENT_TYPE,
        'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
        'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
      },
    })

    const parsed = fromBinary(CodexTaskSchema, toBuffer(structuredPublish.value))
    expect(parsed.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(parsed.issueNumber).toBe(1n)
    expect(parsed.deliveryId).toBe('delivery-123')
  })

  it('surfaces publish failures to the caller', async () => {
    publishKafkaMessageMock.mockClear()
    const runtime = {
      runPromise: vi.fn(async () => {
        throw new Error('publish failed')
      }),
    } as AppRuntime

    await expect(executeWorkflowCommands([publishCommand], baseContext(runtime))).rejects.toThrow('publish failed')
    expect(publishKafkaMessageMock).toHaveBeenCalledTimes(1)
  })
})
