import { fromBinary } from '@bufbuild/protobuf'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexTaskMessage } from '@/codex'
import type { AppRuntime } from '@/effect/runtime'
import { logger } from '@/logger'
import { CodexTaskSchema, CodexTaskStage } from '@/proto/proompteng/froussard/v1/codex_task_pb'
import type { KafkaMessage } from '@/services/kafka'

import { PROTO_CODEX_TASK_FULL_NAME, PROTO_CODEX_TASK_SCHEMA, PROTO_CONTENT_TYPE } from './constants'
import { toCodexTaskProto } from './payloads'
import { executeWorkflowCommands, type WorkflowExecutionContext } from './workflow'

const { publishKafkaMessageMock } = vi.hoisted(() => ({
  publishKafkaMessageMock: vi.fn(),
}))

vi.mock('@/webhooks/utils', () => ({
  publishKafkaMessage: publishKafkaMessageMock,
}))

const baseRuntime = { runPromise: Effect.runPromise } as AppRuntime

const baseContext: WorkflowExecutionContext = {
  runtime: baseRuntime,
  githubService: {} as WorkflowExecutionContext['githubService'],
  runGithub: vi.fn(),
  config: {
    github: {
      token: null,
      apiBaseUrl: 'https://api.github.com',
      userAgent: 'froussard',
    },
    topics: {
      codex: 'codex-topic',
      codexStructured: 'github.issues.codex.tasks',
    },
  },
  deliveryId: 'delivery-123',
  workflowIdentifier: null,
}

const buildMessage = (): CodexTaskMessage => ({
  stage: 'implementation',
  prompt: 'Do the thing',
  repository: 'owner/repo',
  base: 'main',
  head: 'codex/issue-1-test',
  issueNumber: 1,
  issueUrl: 'https://github.com/owner/repo/issues/1',
  issueTitle: 'Test issue',
  issueBody: 'Body',
  sender: 'user',
  issuedAt: '2025-12-22T00:00:00.000Z',
})

const toBuffer = (value: KafkaMessage['value']) => {
  if (typeof value === 'string') {
    return Buffer.from(value)
  }
  if (Buffer.isBuffer(value)) {
    return value
  }
  return Buffer.from(value)
}

describe('executeWorkflowCommands', () => {
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)

  beforeEach(() => {
    publishKafkaMessageMock.mockReset()
    infoSpy.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('publishes implementation messages to Kafka with the expected schema', async () => {
    const publishCalls: KafkaMessage[] = []
    publishKafkaMessageMock.mockImplementation((message: KafkaMessage) => {
      publishCalls.push(message)
      return Effect.succeed(undefined)
    })

    const codexMessage = buildMessage()
    const structuredMessage = toCodexTaskProto(codexMessage, baseContext.deliveryId)

    const result = await executeWorkflowCommands(
      [
        {
          type: 'publishImplementation',
          data: {
            stage: 'implementation',
            key: 'issue-1-implementation',
            codexMessage,
            structuredMessage,
            topics: baseContext.config.topics,
            jsonHeaders: { 'x-request-id': 'req-1', 'x-ignore-me': 123 },
            structuredHeaders: { 'x-request-id': 'req-1', 'x-ignore-me': false },
          },
        },
      ],
      baseContext,
    )

    expect(result.stage).toBe('implementation')
    expect(publishCalls).toHaveLength(2)
    expect(infoSpy).toHaveBeenCalledWith(
      { key: 'issue-1-implementation', deliveryId: baseContext.deliveryId },
      'publishing codex implementation message',
    )

    const [jsonMessage, structuredMessageCall] = publishCalls

    expect(jsonMessage).toMatchObject({
      topic: 'codex-topic',
      key: 'issue-1-implementation',
      headers: {
        'x-request-id': 'req-1',
        'x-codex-task-stage': 'implementation',
      },
    })
    expect(jsonMessage.headers).not.toHaveProperty('x-ignore-me')
    expect(JSON.parse(String(jsonMessage.value))).toMatchObject({
      stage: 'implementation',
      repository: 'owner/repo',
      issueNumber: 1,
    })

    expect(structuredMessageCall).toMatchObject({
      topic: 'github.issues.codex.tasks',
      key: 'issue-1-implementation',
      headers: {
        'x-request-id': 'req-1',
        'x-codex-task-stage': 'implementation',
        'content-type': PROTO_CONTENT_TYPE,
        'x-protobuf-message': PROTO_CODEX_TASK_FULL_NAME,
        'x-protobuf-schema': PROTO_CODEX_TASK_SCHEMA,
      },
    })
    expect(structuredMessageCall.headers).not.toHaveProperty('x-ignore-me')

    const decoded = fromBinary(CodexTaskSchema, toBuffer(structuredMessageCall.value))
    expect(decoded.stage).toBe(CodexTaskStage.IMPLEMENTATION)
    expect(decoded.repository).toBe('owner/repo')
    expect(decoded.issueNumber).toBe(BigInt(1))
    expect(decoded.deliveryId).toBe(baseContext.deliveryId)
  })

  it('surfaces publish failures and stops further publishing', async () => {
    publishKafkaMessageMock.mockImplementationOnce(() => Effect.fail(new Error('boom')))

    const codexMessage = buildMessage()
    const structuredMessage = toCodexTaskProto(codexMessage, baseContext.deliveryId)

    await expect(
      executeWorkflowCommands(
        [
          {
            type: 'publishImplementation',
            data: {
              stage: 'implementation',
              key: 'issue-1-implementation',
              codexMessage,
              structuredMessage,
              topics: baseContext.config.topics,
              jsonHeaders: {},
              structuredHeaders: {},
            },
          },
        ],
        baseContext,
      ),
    ).rejects.toThrow('boom')

    expect(publishKafkaMessageMock).toHaveBeenCalledTimes(1)
  })
})
