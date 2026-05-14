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
