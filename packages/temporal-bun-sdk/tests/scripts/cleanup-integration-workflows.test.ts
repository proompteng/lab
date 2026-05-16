import { describe, expect, test } from 'bun:test'

import {
  isTemporalBatchCapacityError,
  isRetryableTemporalCliError,
  isWorkflowAlreadyCompleted,
  onlyAlreadyResolvedWorkflowsRemainVisible,
  parseWorkflowIdsFromListOutput,
  shouldFallbackToIndividualTermination,
  verifyOnlyStaleVisibility,
  waitForNoRunningWorkflowCount,
  waitForNoRunningWorkflows,
} from '../../scripts/cleanup-integration-workflows'

describe('cleanup integration workflow retries', () => {
  test('retries transient Temporal batch-start placement failures', () => {
    expect(isRetryableTemporalCliError('Error: failed starting batch operation: Not enough hosts to serve the request')).toBe(
      true,
    )
    expect(isRetryableTemporalCliError('Error: failed to describe batch job: Workflow is busy.')).toBe(true)
  })

  test('falls back to individual termination when Temporal batch capacity is saturated', () => {
    const output = 'Error: failed starting batch operation: Max concurrent batch operations is reached'

    expect(isTemporalBatchCapacityError(output)).toBe(true)
    expect(isRetryableTemporalCliError(output)).toBe(false)
    expect(shouldFallbackToIndividualTermination(output)).toBe(true)
  })

  test('does not retry validation failures', () => {
    expect(isRetryableTemporalCliError('Error: invalid search attribute query syntax')).toBe(false)
    expect(shouldFallbackToIndividualTermination('Error: invalid search attribute query syntax')).toBe(false)
  })

  test('treats already completed or missing workflow termination as cleanup success', () => {
    expect(isWorkflowAlreadyCompleted('Error: failed to terminate workflow: workflow execution already completed')).toBe(true)
    expect(isWorkflowAlreadyCompleted('Error: failed to terminate workflow: workflow not found for ID: worker-load')).toBe(true)
    expect(isWorkflowAlreadyCompleted('Error: failed to terminate workflow: permission denied')).toBe(false)
  })

  test('parses workflow ids from Temporal list table output', () => {
    const output = `
Status                         WorkflowId                                 Type             StartTime
  Running  worker-load-cpu-26-4a42c7d7-53a0-49a1-bcb5-2cb1f8b644f6  workerLoadCpuWorkflow  8 minutes ago
  Running  worker-load-cpu-25-8d2e17a2-d6d9-4a8b-93d5-736e551710d8  workerLoadCpuWorkflow  8 minutes ago
  Running  integration-1                                            integrationTimerWorkflow  8 minutes ago
`

    expect(parseWorkflowIdsFromListOutput(output, 'workerLoadCpuWorkflow')).toEqual([
      'worker-load-cpu-26-4a42c7d7-53a0-49a1-bcb5-2cb1f8b644f6',
      'worker-load-cpu-25-8d2e17a2-d6d9-4a8b-93d5-736e551710d8',
    ])
  })

  test('detects stale visibility rows for already resolved workflows', () => {
    const output = `
Status                         WorkflowId                                 Type             StartTime
  Running  worker-load-update-304-0a9e4910-6ffe-40cd-8194-bca78b94aec1  workerLoadUpdateWorkflow  28 minutes ago
`

    expect(
      onlyAlreadyResolvedWorkflowsRemainVisible(output, 'workerLoadUpdateWorkflow', [
        'worker-load-update-304-0a9e4910-6ffe-40cd-8194-bca78b94aec1',
      ]),
    ).toBe(true)
    expect(onlyAlreadyResolvedWorkflowsRemainVisible(output, 'workerLoadUpdateWorkflow', ['other-id'])).toBe(false)
  })

  test('waits for terminated workflows to disappear from visibility', async () => {
    const counts = [3, 2, 0]
    const delays: number[] = []

    await waitForNoRunningWorkflows('WorkflowType="workerLoadActivityWorkflow"', 'workerLoadActivityWorkflow', {
      countRunning: async () => counts.shift() ?? 0,
      sleep: async (delayMs) => {
        delays.push(delayMs)
      },
      maxAttempts: 5,
      retryDelayMs: 10,
    })

    expect(delays).toEqual([10, 20])
  })

  test('fails when terminated workflows remain visible after retries', async () => {
    await expect(
      waitForNoRunningWorkflows('WorkflowType="workerLoadActivityWorkflow"', 'workerLoadActivityWorkflow', {
        countRunning: async () => 1,
        sleep: async () => {},
        maxAttempts: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow('workerLoadActivityWorkflow still has 1 running workflow(s) after cleanup')
  })

  test('returns remaining workflow count for fallback cleanup', async () => {
    const remaining = await waitForNoRunningWorkflowCount('WorkflowType="workerLoadUpdateWorkflow"', {
      countRunning: async () => 2,
      sleep: async () => {},
      maxAttempts: 3,
      retryDelayMs: 1,
    })

    expect(remaining).toBe(2)
  })

  test('verify mode accepts stale visibility for already resolved workflows', async () => {
    const workflowId = 'worker-load-update-304-0a9e4910-6ffe-40cd-8194-bca78b94aec1'
    const output = `
Status                         WorkflowId                                 Type             StartTime
  Running  ${workflowId}  workerLoadUpdateWorkflow  1 hour ago
`

    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      output,
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: [workflowId],
          terminatedWorkflowIds: [],
        }),
        waitForNoRunningCount: async () => 1,
        listRunning: async () => output,
      },
    )

    expect(result).toBe(true)
  })

  test('verify mode fails when a visible workflow required termination', async () => {
    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      'Running  worker-load-update-1  workerLoadUpdateWorkflow  1 minute ago',
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: [],
          terminatedWorkflowIds: ['worker-load-update-1'],
        }),
      },
    )

    expect(result).toBe(false)
  })
})
