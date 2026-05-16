import { describe, expect, test } from 'bun:test'

import { isRetryableTemporalCliError, parseWorkflowIdsFromListOutput } from '../../scripts/cleanup-integration-workflows'

describe('cleanup integration workflow retries', () => {
  test('retries transient Temporal batch-start placement failures', () => {
    expect(isRetryableTemporalCliError('Error: failed starting batch operation: Not enough hosts to serve the request')).toBe(
      true,
    )
  })

  test('does not retry validation failures', () => {
    expect(isRetryableTemporalCliError('Error: invalid search attribute query syntax')).toBe(false)
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
})
