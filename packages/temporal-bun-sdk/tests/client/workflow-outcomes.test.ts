import { describe, expect, test } from 'bun:test'
import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect'

import { createTemporalClient, temporalCallOptions } from '../../src/client'
import { createDefaultDataConverter } from '../../src/common/payloads'
import { loadTemporalConfig } from '../../src/config'
import { UpdateWorkflowExecutionLifecycleStage as Stage } from '../../src/proto/temporal/api/enums/v1/update_pb'
import { HistoryEventSchema } from '../../src/proto/temporal/api/history/v1/message_pb'
import { WorkflowService } from '../../src/proto/temporal/api/workflowservice/v1/service_pb'

const converter = createDefaultDataConverter()
const loadConfig = () =>
  loadTemporalConfig({ env: { TEMPORAL_ADDRESS: '127.0.0.1:7233', TEMPORAL_LOG_LEVEL: 'error' } })
const handle = { namespace: 'outcomes', workflowId: 'workflow', runId: 'run-1', firstExecutionRunId: 'run-1' }
const updateHandle = { ...handle, updateId: 'update-1' }

describe('workflow result run chains', () => {
  const successors: NonNullable<MessageInitShape<typeof HistoryEventSchema>['attributes']>[] = [
    { case: 'workflowExecutionContinuedAsNewEventAttributes', value: { newExecutionRunId: 'run-2' } },
    {
      case: 'workflowExecutionFailedEventAttributes',
      value: { newExecutionRunId: 'run-2', failure: { message: 'retryable attempt' } },
    },
    { case: 'workflowExecutionTimedOutEventAttributes', value: { newExecutionRunId: 'run-2' } },
    { case: 'workflowExecutionCompletedEventAttributes', value: { newExecutionRunId: 'run-2' } },
  ]

  for (const attributes of successors) {
    test(`follows ${attributes.case} with separate history cursors for each run`, async () => {
      const calls: { namespace: string; workflowId: string | undefined; runId: string | undefined }[] = []
      const cursors: number[][] = []
      const transport = createRouterTransport((router) =>
        router.service(WorkflowService, {
          async getWorkflowExecutionHistory(request) {
            calls.push({
              namespace: request.namespace,
              workflowId: request.execution?.workflowId,
              runId: request.execution?.runId,
            })
            cursors.push([...request.nextPageToken])
            if (calls.length === 1) return { history: { events: [] }, nextPageToken: new Uint8Array([1]) }
            if (calls.length === 2) {
              return { history: { events: [create(HistoryEventSchema, { attributes })] } }
            }
            if (calls.length === 3) return { history: { events: [] }, nextPageToken: new Uint8Array([2]) }
            return {
              history: {
                events: [
                  {
                    attributes: {
                      case: 'workflowExecutionCompletedEventAttributes',
                      value: { result: { payloads: await converter.toPayloads(['final result']) } },
                    },
                  },
                ],
              },
            }
          },
        }),
      )
      const { client } = await createTemporalClient({ config: await loadConfig(), transport })
      try {
        await expect(client.workflow.result(handle)).resolves.toBe('final result')
        expect(calls.map(({ runId }) => runId)).toEqual(['run-1', 'run-1', 'run-2', 'run-2'])
        expect(cursors).toEqual([[], [1], [], [2]])
        expect(
          calls.every((call) => call.namespace === handle.namespace && call.workflowId === handle.workflowId),
        ).toBe(true)
        expect(handle.runId).toBe('run-1')
      } finally {
        await client.shutdown()
      }
    })
  }

  test('reports a terminal failure after multiple successor runs', async () => {
    const calls: (string | undefined)[] = []
    const transport = createRouterTransport((router) =>
      router.service(WorkflowService, {
        getWorkflowExecutionHistory(request) {
          calls.push(request.execution?.runId)
          return {
            history: {
              events: [
                {
                  attributes: {
                    case: 'workflowExecutionFailedEventAttributes',
                    value: {
                      failure: { message: calls.length < 3 ? 'intermediate failure' : 'final failure' },
                      newExecutionRunId: calls.length < 3 ? `run-${calls.length + 1}` : '',
                    },
                  },
                },
              ],
            },
          }
        },
      }),
    )
    const { client } = await createTemporalClient({ config: await loadConfig(), transport })
    try {
      await expect(client.workflow.result(handle)).rejects.toThrow('final failure')
      expect(calls).toEqual(['run-1', 'run-2', 'run-3'])
    } finally {
      await client.shutdown()
    }
  })
})

describe('workflow update long polling', () => {
  for (const waitForStage of ['accepted', 'completed'] as const) {
    test(`continues polling until the requested ${waitForStage} stage`, async () => {
      const requestedStages: Stage[] = []
      const stages = [Stage.UNSPECIFIED, Stage.ADMITTED, Stage.ACCEPTED, Stage.COMPLETED]
      const transport = createRouterTransport((router) =>
        router.service(WorkflowService, {
          async pollWorkflowExecutionUpdate(request) {
            requestedStages.push(request.waitPolicy?.lifecycleStage ?? Stage.UNSPECIFIED)
            expect(request.updateRef?.updateId).toBe(updateHandle.updateId)
            expect(request.updateRef?.workflowExecution?.runId).toBe(updateHandle.runId)
            expect(request.namespace).toBe(updateHandle.namespace)
            const stage = stages[requestedStages.length - 1]
            return {
              stage,
              ...(stage === Stage.COMPLETED
                ? {
                    outcome: {
                      value: { case: 'success' as const, value: { payloads: await converter.toPayloads(['updated']) } },
                    },
                  }
                : {}),
            }
          },
        }),
      )
      const { client } = await createTemporalClient({ config: await loadConfig(), transport })
      try {
        const result = await client.workflow.awaitUpdate(updateHandle, { waitForStage })
        expect(result.stage).toBe(waitForStage)
        expect(result.handle).toEqual(updateHandle)
        if (waitForStage === 'completed') expect(result.outcome).toEqual({ status: 'success', result: 'updated' })
        expect(requestedStages).toEqual(
          Array(waitForStage === 'accepted' ? 3 : 4).fill(
            waitForStage === 'accepted' ? Stage.ACCEPTED : Stage.COMPLETED,
          ),
        )
      } finally {
        await client.shutdown()
      }
    })
  }

  test('propagates a terminal polling RPC failure after an incomplete response', async () => {
    let polls = 0
    const transport = createRouterTransport((router) =>
      router.service(WorkflowService, {
        pollWorkflowExecutionUpdate() {
          if (++polls === 1) return { stage: Stage.UNSPECIFIED }
          throw new ConnectError('update no longer exists', Code.NotFound)
        },
      }),
    )
    const { client } = await createTemporalClient({ config: await loadConfig(), transport })
    try {
      await expect(client.workflow.awaitUpdate(updateHandle)).rejects.toThrow('update no longer exists')
      expect(polls).toBe(2)
    } finally {
      await client.shutdown()
    }
  })

  for (const cancellation of ['signal', 'cancelUpdate'] as const) {
    test(`honors ${cancellation} cancellation after an incomplete response`, async () => {
      let polls = 0
      let cancel: () => Promise<void> | void = () => undefined
      const controller = new AbortController()
      const transport = createRouterTransport((router) =>
        router.service(WorkflowService, {
          async pollWorkflowExecutionUpdate() {
            polls += 1
            await cancel()
            return { stage: Stage.UNSPECIFIED }
          },
        }),
      )
      const { client } = await createTemporalClient({ config: await loadConfig(), transport })
      cancel = cancellation === 'signal' ? () => controller.abort() : () => client.workflow.cancelUpdate(updateHandle)
      try {
        await expect(
          client.workflow.awaitUpdate(updateHandle, {}, temporalCallOptions({ signal: controller.signal })),
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(polls).toBe(1)
      } finally {
        await client.shutdown()
      }
    })
  }
})
