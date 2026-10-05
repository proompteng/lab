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
    expect(
      isRetryableTemporalCliError('Error: failed starting batch operation: Not enough hosts to serve the request'),
    ).toBe(true)
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
    expect(
      isWorkflowAlreadyCompleted('Error: failed to terminate workflow: workflow execution already completed'),
    ).toBe(true)
    expect(
      isWorkflowAlreadyCompleted('Error: failed to terminate workflow: workflow not found for ID: worker-load'),
    ).toBe(true)
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

  test('an initially empty list requires a fresh zero count for the identical query', async () => {
    const query = 'WorkflowType="workerLoadActivityWorkflow" and ExecutionStatus="Running"'
    const queries: string[] = []
    const result = await verifyOnlyStaleVisibility(query, 'workerLoadActivityWorkflow', ' \n', {
      countRunning: async (actualQuery) => {
        queries.push(actualQuery)
        return 0
      },
      terminateVisibleWorkflows: async () => {
        throw new Error('An empty list must not attempt termination')
      },
    })
    expect(result).toBe(true)
    expect(queries).toEqual([query])
  })

  test('an initially empty list cannot hide a nonzero or malformed follow-up count', async () => {
    for (const remaining of [3, Number.NaN]) {
      expect(
        await verifyOnlyStaleVisibility('WorkflowType="workerLoadActivityWorkflow"', 'workerLoadActivityWorkflow', '', {
          countRunning: async () => remaining,
        }),
      ).toBe(false)
    }
  })

  test('an initially empty list propagates count failures', async () => {
    await expect(
      verifyOnlyStaleVisibility('WorkflowType="workerLoadActivityWorkflow"', 'workerLoadActivityWorkflow', '', {
        countRunning: async () => {
          throw new Error('count command failed')
        },
      }),
    ).rejects.toThrow('count command failed')
  })

  test('a malformed nonempty list still fails parsing even when the count is zero', async () => {
    await expect(
      verifyOnlyStaleVisibility(
        'WorkflowType="workerLoadActivityWorkflow"',
        'workerLoadActivityWorkflow',
        'malformed output',
        {
          countRunning: async () => 0,
        },
      ),
    ).rejects.toThrow('Unable to parse')
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
        countRunning: async () => 1,
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

  test('terminal workflows are verified with one count instead of waiting for stale visibility', async () => {
    let countCalls = 0
    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago',
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: ['closed-workflow'],
          terminatedWorkflowIds: [],
        }),
        countRunning: async () => {
          countCalls += 1
          return 1
        },
        listRunning: async () => 'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago',
      },
    )
    expect(result).toBe(true)
    expect(countCalls).toBe(1)
  })

  test('stale visibility does not hide an additional workflow appearing during verification', async () => {
    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago',
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: ['closed-workflow'],
          terminatedWorkflowIds: [],
        }),
        countRunning: async () => 2,
        listRunning: async () =>
          'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago\nRunning newly-running workerLoadUpdateWorkflow 1 second ago',
      },
    )
    expect(result).toBe(false)
  })

  test('accepts a stale record disappearing between the count and list', async () => {
    const counts = [1, 0]
    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago',
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: ['closed-workflow'],
          terminatedWorkflowIds: [],
        }),
        countRunning: async () => counts.shift() ?? 0,
        listRunning: async () => '',
      },
    )
    expect(result).toBe(true)
  })

  test('an empty list cannot hide a nonzero follow-up workflow count', async () => {
    const result = await verifyOnlyStaleVisibility(
      'WorkflowType="workerLoadUpdateWorkflow"',
      'workerLoadUpdateWorkflow',
      'Running closed-workflow workerLoadUpdateWorkflow 1 hour ago',
      {
        terminateVisibleWorkflows: async () => ({
          alreadyResolvedWorkflowIds: ['closed-workflow'],
          terminatedWorkflowIds: [],
        }),
        countRunning: async () => 1,
        listRunning: async () => '',
      },
    )
    expect(result).toBe(false)
  })
})
