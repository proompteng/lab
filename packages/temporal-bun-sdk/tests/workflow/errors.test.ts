import { describe, expect, test } from 'bun:test'

import {
  ContinueAsNewWorkflowError,
  WorkflowBlockedError,
  WorkflowDeterminismGuardError,
  WorkflowError,
  WorkflowNondeterminismError,
} from '../../src/workflow/errors'

describe('workflow error types', () => {
  test('WorkflowError sets name and message', () => {
    const error = new WorkflowError('boom')
    expect(error.name).toBe('WorkflowError')
    expect(error.message).toBe('boom')
  })

  test('WorkflowBlockedError includes reason', () => {
    const error = new WorkflowBlockedError('waiting on signal')
    expect(error.name).toBe('WorkflowBlockedError')
    expect(error.reason).toBe('waiting on signal')
    expect(error.message).toContain('waiting on signal')
  })

  test('WorkflowNondeterminismError carries details', () => {
    const error = new WorkflowNondeterminismError('mismatch', { expected: 1, received: 2 })
    expect(error.name).toBe('WorkflowNondeterminismError')
    expect(error.details).toEqual({ expected: 1, received: 2 })
  })

  test('WorkflowDeterminismGuardError and ContinueAsNewWorkflowError set custom names', () => {
    expect(new WorkflowDeterminismGuardError('bad state').name).toBe('WorkflowDeterminismGuardError')
    expect(new ContinueAsNewWorkflowError().name).toBe('ContinueAsNewWorkflowError')
  })
})
