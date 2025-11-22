import { expect, test } from 'bun:test'

import { createWorkflowContext } from '../../src/workflow/context'
import { DeterminismGuard, type WorkflowDeterminismState } from '../../src/workflow/determinism'

const baseInfo = {
  namespace: 'default',
  taskQueue: 'replay-fixtures',
  workflowId: 'wf-primitive',
  runId: 'run-primitive',
  workflowType: 'primitiveWorkflow',
}

test('determinism.sideEffect reuses recorded marker payloads', () => {
  let executed = 0
  const previous: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          id: 'record-marker-0',
          kind: 'record-marker',
          sequence: 0,
          markerName: 'temporal-bun-sdk/side-effect',
          details: { result: 42 },
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const guard = new DeterminismGuard({ previousState: previous })
  const { context, commandContext } = createWorkflowContext({
    input: undefined,
    info: baseInfo,
    determinismGuard: guard,
  })

  const result = context.determinism.sideEffect<number>({
    compute: () => {
      executed += 1
      return 7
    },
  })

  expect(result).toBe(42)
  expect(executed).toBe(0)
  expect(guard.snapshot.commandHistory).toHaveLength(1)
  const intent = guard.snapshot.commandHistory[0]?.intent
  expect(intent?.kind).toBe('record-marker')
  if (intent?.kind === 'record-marker') {
    expect(intent.details?.result).toBe(42)
  }
})

test('determinism.getVersion records chosen version when absent', () => {
  const guard = new DeterminismGuard()
  const { context, commandContext } = createWorkflowContext({
    input: undefined,
    info: { ...baseInfo, workflowId: 'wf-version' },
    determinismGuard: guard,
  })

  const version = context.determinism.getVersion({ changeId: 'feature-v1', minSupported: 1, maxSupported: 3 })

  expect(version).toBe(3)
  expect(commandContext.intents).toHaveLength(1)
  const intent = commandContext.intents[0]
  expect(intent.kind).toBe('record-marker')
  if (intent.kind === 'record-marker') {
    expect(intent.markerName).toBe('temporal-bun-sdk/get-version')
    expect(intent.details?.changeId).toBe('feature-v1')
    expect(intent.details?.version).toBe(3)
  }
})
