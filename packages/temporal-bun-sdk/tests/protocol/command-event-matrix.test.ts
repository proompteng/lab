import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import {
  materializeCommands,
  workflowCommandEventMatrix,
  workflowCommandKinds,
  type WorkflowCommandIntent,
  type WorkflowCommandKind,
} from '../../src/workflow'
import type { WorkflowInfo } from '../../src/workflow/context'

const workflowInfo: WorkflowInfo = {
  namespace: 'default',
  taskQueue: 'matrix-task-queue',
  workflowId: 'matrix-workflow-id',
  runId: 'matrix-run-id',
  workflowType: 'matrixWorkflow',
}

const dataConverter = createDefaultDataConverter()

const sampleIntentByKind: Record<WorkflowCommandKind, WorkflowCommandIntent> = {
  'schedule-activity': {
    id: 'schedule-activity-0',
    kind: 'schedule-activity',
    sequence: 0,
    activityType: 'matrixActivity',
    activityId: 'activity-0',
    taskQueue: 'matrix-task-queue',
    input: [{ value: 'activity-input' }],
    timeouts: {
      scheduleToCloseTimeoutMs: 10_000,
      startToCloseTimeoutMs: 5_000,
      heartbeatTimeoutMs: 1_000,
    },
    retry: { maximumAttempts: 3 },
  },
  'schedule-nexus-operation': {
    id: 'schedule-nexus-operation-1',
    kind: 'schedule-nexus-operation',
    sequence: 1,
    endpoint: 'matrix-endpoint',
    service: 'matrix-service',
    operation: 'matrix-operation',
    operationId: 'matrix-operation-id',
    input: { value: 'nexus-input' },
    scheduleToCloseTimeoutMs: 5_000,
  },
  'start-timer': {
    id: 'start-timer-2',
    kind: 'start-timer',
    sequence: 2,
    timerId: 'timer-2',
    timeoutMs: 250,
  },
  'request-cancel-activity': {
    id: 'request-cancel-activity-3',
    kind: 'request-cancel-activity',
    sequence: 3,
    activityId: 'activity-0',
    scheduledEventId: '11',
  },
  'request-cancel-nexus-operation': {
    id: 'request-cancel-nexus-operation-4',
    kind: 'request-cancel-nexus-operation',
    sequence: 4,
    operationId: 'matrix-operation-id',
    scheduledEventId: '12',
  },
  'cancel-timer': {
    id: 'cancel-timer-5',
    kind: 'cancel-timer',
    sequence: 5,
    timerId: 'timer-2',
    startedEventId: '13',
  },
  'start-child-workflow': {
    id: 'start-child-workflow-6',
    kind: 'start-child-workflow',
    sequence: 6,
    workflowType: 'childWorkflow',
    workflowId: 'child-workflow-id',
    namespace: 'default',
    taskQueue: 'matrix-child-task-queue',
    input: ['child-input'],
    timeouts: {
      workflowExecutionTimeoutMs: 20_000,
      workflowRunTimeoutMs: 15_000,
      workflowTaskTimeoutMs: 5_000,
    },
  },
  'signal-external-workflow': {
    id: 'signal-external-workflow-7',
    kind: 'signal-external-workflow',
    sequence: 7,
    namespace: 'default',
    workflowId: 'external-workflow-id',
    runId: 'external-run-id',
    signalName: 'matrix-signal',
    input: ['signal-input'],
    childWorkflowOnly: false,
  },
  'request-cancel-external-workflow': {
    id: 'request-cancel-external-workflow-8',
    kind: 'request-cancel-external-workflow',
    sequence: 8,
    namespace: 'default',
    workflowId: 'external-workflow-id',
    runId: 'external-run-id',
    childWorkflowOnly: false,
    reason: 'matrix-cancel',
  },
  'cancel-workflow': {
    id: 'cancel-workflow-9',
    kind: 'cancel-workflow',
    sequence: 9,
    details: ['cancel-detail'],
  },
  'record-marker': {
    id: 'record-marker-10',
    kind: 'record-marker',
    sequence: 10,
    markerName: 'matrix-marker',
    details: { value: 42 },
  },
  'upsert-search-attributes': {
    id: 'upsert-search-attributes-11',
    kind: 'upsert-search-attributes',
    sequence: 11,
    searchAttributes: { SearchKeywordField: 'matrix' },
  },
  'modify-workflow-properties': {
    id: 'modify-workflow-properties-12',
    kind: 'modify-workflow-properties',
    sequence: 12,
    memo: { matrixMemo: 'value' },
  },
  'continue-as-new': {
    id: 'continue-as-new-13',
    kind: 'continue-as-new',
    sequence: 13,
    workflowType: 'matrixWorkflow',
    taskQueue: 'matrix-task-queue',
    input: ['next-run'],
    timeouts: {
      workflowRunTimeoutMs: 15_000,
      workflowTaskTimeoutMs: 5_000,
    },
  },
}

test('command/event compatibility matrix covers every supported workflow command kind', () => {
  const matrixKinds = Object.keys(workflowCommandEventMatrix).sort()
  const declaredKinds = [...workflowCommandKinds].sort()
  const sampleKinds = Object.keys(sampleIntentByKind).sort()

  expect(matrixKinds).toEqual(declaredKinds)
  expect(sampleKinds).toEqual(declaredKinds)

  for (const kind of workflowCommandKinds) {
    const entry = workflowCommandEventMatrix[kind]
    expect(entry.kind).toBe(kind)
    expect(entry.attributesCase.length).toBeGreaterThan(0)
    expect(entry.expectedHistoryEventFamilies.length).toBeGreaterThan(0)
  }
})

test('command/event matrix matches materialized Temporal command projections', async () => {
  const intents = workflowCommandKinds.map((kind) => sampleIntentByKind[kind])
  const commands = await materializeCommands(intents, { dataConverter, workflowInfo })

  expect(commands).toHaveLength(workflowCommandKinds.length)
  for (const [index, kind] of workflowCommandKinds.entries()) {
    const entry = workflowCommandEventMatrix[kind]
    const command = commands[index]
    expect(command.commandType).toBe(entry.commandType)
    expect(command.attributes.case).toBe(entry.attributesCase)
  }
})
