import { expect, test } from 'bun:test'

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
