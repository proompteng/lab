import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { TemporalConfig } from '../../src/config'
import { parseExecutionFlag, replayCommandTestHooks } from '../../src/bin/replay-command'
import type { HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'

const fixturePath = join(import.meta.dir, '../replay/fixtures/timer-workflow.json')

const baseConfig: TemporalConfig = {
  host: '127.0.0.1',
  port: 7233,
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'prix',
  apiKey: undefined,
  tls: undefined,
  allowInsecureTls: true,
  workerIdentity: 'replay-test-worker',
  workerIdentityPrefix: 'replay-test',
  showStackTraceSources: false,
  workerWorkflowConcurrency: 1,
  workerActivityConcurrency: 1,
  workerStickyCacheSize: 1,
  workerStickyTtlMs: 1,
  stickySchedulingEnabled: true,
  activityHeartbeatIntervalMs: 1,
  activityHeartbeatRpcTimeoutMs: 1,
  workerDeploymentName: undefined,
  workerBuildId: undefined,
  logLevel: 'info',
  logFormat: 'pretty',
  metricsExporter: { type: 'in-memory' },
  rpcRetryPolicy: {
    maxAttempts: 1,
    initialDelayMs: 1,
    maxDelayMs: 1,
    backoffCoefficient: 1,
    jitterFactor: 0,
    retryableStatusCodes: [],
  },
}

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
  })

  expect(outcome.record.source).toBe('service')
  expect(outcome.record.events).toHaveLength(1)
  expect(outcome.attempts).toHaveLength(1)
  expect(outcome.attempts[0]?.source).toBe('cli')
})
