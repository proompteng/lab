import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'

import { temporalCliTestHooks } from '../../src/bin/temporal-bun'
import type { TemporalConfig } from '../../src/config'
import { parseExecutionFlag, replayCommandTestHooks } from '../../src/bin/replay-command'
import type { HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'
import {
  ObservabilityService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../../src/runtime/effect-layers'
import type { WorkflowServiceClient } from '../../src/runtime/effect-layers'
import { createObservabilityStub, createTestTemporalConfig } from '../helpers/observability'

const fixturePath = join(import.meta.dir, '../replay/fixtures/timer-workflow.json')

const baseConfig: TemporalConfig = createTestTemporalConfig({
  workerIdentity: 'replay-test-worker',
  workerIdentityPrefix: 'replay-test',
})

describe('parseExecutionFlag', () => {
  test('parses workflowId/runId values', () => {
    expect(parseExecutionFlag('wf/run')).toEqual({ workflowId: 'wf', runId: 'run' })
  })

  test('throws when format is invalid', () => {
    expect(() => parseExecutionFlag('missing-run')).toThrow()
  })
})

test('loadHistoryFromFile parses replay fixtures', async () => {
  const record = await replayCommandTestHooks.loadHistoryFromFile(fixturePath)
  expect(record.events.length).toBeGreaterThan(0)
  expect(record.source).toBe('file')
  expect(record.metadata.workflowType).toBe('timerWorkflow')
})

test('loadExecutionHistory falls back from CLI to service loaders', async () => {
  const cliError = new Error('cli missing')
  const options = {
    historyFile: undefined,
    execution: { workflowId: 'wf-id', runId: 'run-id' },
    workflowType: 'exampleWorkflow',
    namespaceOverride: undefined,
    temporalCliPath: undefined,
    source: 'auto',
    jsonOutput: false,
  } satisfies Parameters<typeof replayCommandTestHooks.loadExecutionHistory>[0]['options']

  const serviceEvent: HistoryEvent = { eventId: 1n, eventType: 1 }

  const outcome = await replayCommandTestHooks.loadExecutionHistory({
    options,
    config: baseConfig,
    loaders: {
      cli: async () => {
        throw cliError
      },
      service: async () => ({
        events: [serviceEvent],
        source: 'service',
        description: 'service-loader',
        metadata: {
          workflowId: 'wf-id',
          runId: 'run-id',
          namespace: baseConfig.namespace,
        },
      }),
    },
    workflowService: {} as WorkflowServiceClient,
  })

  expect(outcome.record.source).toBe('service')
  expect(outcome.record.events).toHaveLength(1)
  expect(outcome.attempts).toHaveLength(1)
  expect(outcome.attempts[0]?.source).toBe('cli')
})

test('handleReplay logs through injected observability services', async () => {
  const observability = createObservabilityStub()
  const layer = Layer.mergeAll(
    Layer.succeed(TemporalConfigService, baseConfig),
    Layer.succeed(ObservabilityService, observability.services),
    Layer.succeed(WorkflowServiceClientService, {} as WorkflowServiceClient),
  )

  await Effect.runPromise(
    Effect.provide(
      temporalCliTestHooks.handleReplay([], { 'history-file': fixturePath }),
      layer,
    ),
  )

  expect(observability.logs.some((entry) => entry.message === 'temporal-bun replay started')).toBeTrue()
})
