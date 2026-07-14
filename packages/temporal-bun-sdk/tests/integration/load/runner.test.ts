import { expect, test } from 'bun:test'

import { Code, ConnectError } from '@connectrpc/connect'

import { WorkflowExecutionStatus } from '../../../src/proto/temporal/api/enums/v1/workflow_pb'
import { __workerLoadTestHooks } from './runner'

test('worker load completion verifier normalizes SDK enum statuses', () => {
  expect(__workerLoadTestHooks.normalizeWorkflowStatus(WorkflowExecutionStatus.RUNNING)).toBe('RUNNING')
  expect(__workerLoadTestHooks.normalizeWorkflowStatus(WorkflowExecutionStatus.COMPLETED)).toBe('COMPLETED')
  expect(__workerLoadTestHooks.normalizeWorkflowStatus(WorkflowExecutionStatus.CANCELED)).toBe('CANCELED')
  expect(__workerLoadTestHooks.normalizeWorkflowStatus(WorkflowExecutionStatus.TERMINATED)).toBe('TERMINATED')
  expect(__workerLoadTestHooks.normalizeWorkflowStatus(WorkflowExecutionStatus.FAILED)).toBe('FAILED')
})

test('worker load completion verifier normalizes CLI-style status strings', () => {
  expect(__workerLoadTestHooks.normalizeWorkflowStatus('WORKFLOW_EXECUTION_STATUS_RUNNING')).toBe('RUNNING')
  expect(__workerLoadTestHooks.normalizeWorkflowStatus('completed')).toBe('COMPLETED')
})

test('worker load completion budget includes metrics flush window', () => {
  expect(
    __workerLoadTestHooks.calculateLoadCompletionBudgetMs({
      workflowDurationBudgetMs: 300_000,
      metricsFlushTimeoutMs: 2_000,
    }),
  ).toBe(305_000)
  expect(
    __workerLoadTestHooks.calculateLoadCompletionBudgetMs({
      workflowDurationBudgetMs: 300_000,
      metricsFlushTimeoutMs: 30_000,
    }),
  ).toBe(330_000)
})

test('worker load completion budget covers activity timeout envelope and describe drain', () => {
  expect(
    __workerLoadTestHooks.calculateLoadCompletionBudgetMs({
      workflowDurationBudgetMs: 100_000,
      activityScheduleToStartTimeoutMs: 90_000,
      activityStartToCloseTimeoutMs: 60_000,
      activityScheduleToCloseTimeoutMs: 150_000,
      workflowCount: 16,
      workflowDescribeConcurrency: 32,
      metricsFlushTimeoutMs: 5_000,
    }),
  ).toBe(160_000)
})

test('worker load Bun test timeout budget covers completion budget plus harness margin', () => {
  const config = {
    workflowDurationBudgetMs: 105_000,
    activityScheduleToStartTimeoutMs: 90_000,
    activityStartToCloseTimeoutMs: 60_000,
    activityScheduleToCloseTimeoutMs: 150_000,
    workflowCount: 64,
    workflowDescribeConcurrency: 32,
    metricsFlushTimeoutMs: 5_000,
  }
  const completionBudgetMs = __workerLoadTestHooks.calculateLoadCompletionBudgetMs(config)

  expect(completionBudgetMs).toBe(170_000)
  expect(__workerLoadTestHooks.calculateWorkerLoadTestTimeoutBudgetMs(config)).toBe(completionBudgetMs + 15_000)
})

test('worker load update termination treats already-completed races as terminal success', () => {
  expect(
    __workerLoadTestHooks.isWorkflowAlreadyCompletedForTermination(
      new ConnectError('workflow execution already completed', Code.NotFound),
    ),
  ).toBe(true)
  expect(
    __workerLoadTestHooks.isWorkflowAlreadyCompletedForTermination({
      _tag: 'UnknownException',
      cause: new ConnectError('[not_found] workflow execution already completed', Code.NotFound),
    }),
  ).toBe(true)
})

test('worker load update termination keeps unrelated not-found failures fatal', () => {
  expect(
    __workerLoadTestHooks.isWorkflowAlreadyCompletedForTermination(
      new ConnectError('workflow execution not found', Code.NotFound),
    ),
  ).toBe(false)
  expect(
    __workerLoadTestHooks.isWorkflowAlreadyCompletedForTermination(
      new ConnectError('workflow execution already completed', Code.Unavailable),
    ),
  ).toBe(false)
})

test('worker load update drive tolerates workflows that complete before an update', async () => {
  type DriveClient = Parameters<typeof __workerLoadTestHooks.driveWorkflowUpdates>[0]
  type DriveSubmission = Parameters<typeof __workerLoadTestHooks.driveWorkflowUpdates>[1][number]
  type DriveConfig = Parameters<typeof __workerLoadTestHooks.driveWorkflowUpdates>[2]
  let terminateCalls = 0
  const client = {
    workflow: {
      update: async () => {
        throw new ConnectError('workflow execution already completed', Code.NotFound)
      },
      terminate: async () => {
        terminateCalls += 1
      },
    },
  } as unknown as DriveClient
  const submission = {
    plan: {
      id: 'completed-before-update',
      workflowType: 'workerLoadUpdateWorkflow',
      input: { cycles: 2, holdMs: 250, delayMs: 50 },
    },
    handle: { workflowId: 'completed-before-update', runId: 'run-1' },
  } satisfies DriveSubmission
  const config = {
    updatesPerWorkflow: 1,
    updateDelayMs: 50,
  } as DriveConfig

  const events = await __workerLoadTestHooks.driveWorkflowUpdates(client, [submission], config)

  expect(events).toHaveLength(1)
  expect(events[0]?.status).toBe('already-completed')
  expect(terminateCalls).toBe(0)
})

test('worker load update termination classifies shard-status cleanup transients', () => {
  expect(
    __workerLoadTestHooks.isTransientWorkflowTerminationCleanupFailure(
      new ConnectError('[unavailable] shard status unknown', Code.Unavailable),
    ),
  ).toBe(true)
  expect(
    __workerLoadTestHooks.isTransientWorkflowTerminationCleanupFailure({
      _tag: 'UnknownException',
      cause: new ConnectError('[unavailable] shard status unknown', Code.Unavailable),
    }),
  ).toBe(true)
  expect(
    __workerLoadTestHooks.isTransientWorkflowTerminationCleanupFailure(
      new ConnectError('[unavailable] Not enough hosts to serve the request', Code.Unavailable),
    ),
  ).toBe(true)
})

test('worker load update termination keeps non-unavailable cleanup failures fatal', () => {
  expect(
    __workerLoadTestHooks.isTransientWorkflowTerminationCleanupFailure(
      new ConnectError('[not_found] workflow execution already completed', Code.NotFound),
    ),
  ).toBe(false)
  expect(
    __workerLoadTestHooks.isTransientWorkflowTerminationCleanupFailure(
      new ConnectError('[internal] shard status unknown', Code.Internal),
    ),
  ).toBe(false)
})

test('worker load failure cleanup terminates only non-terminal submitted workflows', async () => {
  const terminatedWorkflowIds: string[] = []
  type CleanupClient = Parameters<typeof __workerLoadTestHooks.cleanupSubmittedWorkflows>[0]
  const client = {
    workflow: {
      terminate: async (handle: { workflowId: string; runId: string }, options: { reason: string }) => {
        expect(options.reason).toBe('test-cleanup')
        terminatedWorkflowIds.push(handle.workflowId)
      },
    },
  } as unknown as CleanupClient

  const events = await __workerLoadTestHooks.cleanupSubmittedWorkflows(
    client,
    [
      { workflowId: 'completed', runId: 'run-completed' },
      { workflowId: 'running', runId: 'run-running' },
      { workflowId: 'unobserved', runId: 'run-unobserved' },
      { workflowId: 'canceled', runId: 'run-canceled' },
    ],
    [
      { workflowId: 'completed', runId: 'run-completed', status: 'COMPLETED' },
      { workflowId: 'running', runId: 'run-running', status: 'RUNNING' },
      { workflowId: 'canceled', runId: 'run-canceled', status: 'CANCELED' },
    ],
    'test-cleanup',
    2,
  )

  expect(terminatedWorkflowIds.sort()).toEqual(['running', 'unobserved'])
  expect(events.map((event) => event.status).sort()).toEqual(['terminated', 'terminated'])
})

test('worker load failure cleanup reports already-completed, transient, and failed terminations', async () => {
  type CleanupClient = Parameters<typeof __workerLoadTestHooks.cleanupSubmittedWorkflows>[0]
  const client = {
    workflow: {
      terminate: async (handle: { workflowId: string }) => {
        if (handle.workflowId === 'already-completed') {
          throw new ConnectError('workflow execution already completed', Code.NotFound)
        }
        if (handle.workflowId === 'transient') {
          throw {
            _tag: 'UnknownException',
            cause: new ConnectError('[unavailable] Not enough hosts to serve the request', Code.Unavailable),
          }
        }
        throw new Error('backend unavailable')
      },
    },
  } as unknown as CleanupClient

  const events = await __workerLoadTestHooks.cleanupSubmittedWorkflows(
    client,
    [
      { workflowId: 'already-completed', runId: 'run-already-completed' },
      { workflowId: 'transient', runId: 'run-transient' },
      { workflowId: 'failed', runId: 'run-failed' },
    ],
    [],
    'test-cleanup',
    1,
  )

  expect(events.map((event) => [event.workflowId, event.status]).sort()).toEqual([
    ['already-completed', 'already-completed'],
    ['failed', 'failed'],
    ['transient', 'transient-cleanup-failed'],
  ])
})
