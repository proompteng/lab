import { expect, test } from 'bun:test'
import type {
  ActivityResolution,
  ExecuteWorkflowInput,
  WorkflowDefinitions,
  WorkflowExecutionOutput,
} from '@proompteng/temporal-bun-sdk/workflow'
import {
  CommandType,
  createDefaultDataConverter,
  decodePayloadsToValues,
  WorkflowExecutor,
  WorkflowRegistry,
} from '@proompteng/temporal-bun-sdk/workflow'

import { workflows } from './index'

type ExecuteOverrides = Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  registry.registerMany(workflows as WorkflowDefinitions)
  return { registry, executor, dataConverter }
}

const execute = async (executor: WorkflowExecutor, overrides: ExecuteOverrides): Promise<WorkflowExecutionOutput> =>
  await executor.execute({
    workflowType: overrides.workflowType,
    arguments: overrides.arguments,
    workflowId: overrides.workflowId ?? 'test-workflow-id',
    runId: overrides.runId ?? 'test-run-id',
    namespace: overrides.namespace ?? 'default',
    taskQueue: overrides.taskQueue ?? 'bumba',
    determinismState: overrides.determinismState,
    activityResults: overrides.activityResults,
    activityScheduleEventIds: overrides.activityScheduleEventIds,
    pendingChildWorkflows: overrides.pendingChildWorkflows,
    signalDeliveries: overrides.signalDeliveries,
    timerResults: overrides.timerResults,
    updates: overrides.updates,
    mode: overrides.mode,
  })

test('publishMainMergeMemoryNote delegates durable delivery to a retrying activity', async () => {
  const { executor } = makeExecutor()
  const input = {
    eventId: 'event-1',
    deliveryId: 'delivery-1',
    repoRoot: '/workspace/lab',
    ref: 'refs/heads/main',
    commit: 'abcdef1234567890',
  }

  const output = await execute(executor, {
    workflowType: 'publishMainMergeMemoryNote',
    arguments: input,
  })

  expect(output.completion).toBe('pending')
  const intent = output.determinismState.commandHistory[0]?.intent
  expect(intent?.kind).toBe('schedule-activity')
  if (intent?.kind !== 'schedule-activity') throw new Error('expected schedule-activity intent')
  expect(intent.activityType).toBe('publishMainMergeMemoryNote')
  expect(intent.input).toEqual([input])
  expect(intent.retry?.maximumAttempts).toBeUndefined()
  expect(intent.timeouts.scheduleToCloseTimeoutMs).toBe(7 * 24 * 60 * 60 * 1_000)
})

test('reconcileAtlasRepository schedules one bounded full-repository activity', async () => {
  const { executor, dataConverter } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab',
    repository: 'proompteng/lab',
    ref: 'main',
    commit: 'abcdef1234567890abcdef1234567890abcdef1234',
  }

  const output = await execute(executor, { workflowType: 'reconcileAtlasRepository', arguments: input })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(2)
  expect(output.commands[0]?.commandType).toBe(CommandType.RECORD_MARKER)
  const schedule = output.commands[1]
  if (!schedule) throw new Error('Expected Atlas reconciliation activity command.')
  expect(schedule.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  if (schedule.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
    throw new Error('Expected Atlas reconciliation activity command.')
  }
  const attributes = schedule.attributes.value
  expect(attributes.activityType?.name).toBe('reconcileAtlasRepository')
  expect(Number(attributes.startToCloseTimeout?.seconds ?? 0n)).toBe(24 * 60 * 60)
  expect(Number(attributes.scheduleToCloseTimeout?.seconds ?? 0n)).toBe(3 * 24 * 60 * 60)
  expect(Number(attributes.heartbeatTimeout?.seconds ?? 0n)).toBe(90)
  expect(attributes.retryPolicy?.maximumAttempts).toBe(0)
  expect(await decodePayloadsToValues(dataConverter, attributes.input?.payloads ?? [])).toEqual([input])
})

test('reconcileAtlasRepository waits for the reconciliation activity before finalizing ingestion', async () => {
  const { executor } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab',
    repository: 'proompteng/lab',
    ref: 'main',
    commit: 'abcdef1234567890abcdef1234567890abcdef1234',
    eventDeliveryId: 'delivery-1',
  }

  const initial = await execute(executor, { workflowType: 'reconcileAtlasRepository', arguments: input })
  expect(initial.completion).toBe('pending')

  const runningUpsertCompleted = new Map<string, ActivityResolution>([
    ['activity-0', { status: 'completed', value: { ingestionId: 'ingestion-1' } }],
  ])
  const reconciliationPending = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: initial.determinismState,
    activityResults: runningUpsertCompleted,
  })

  expect(reconciliationPending.completion).toBe('pending')
  const pendingIntents = reconciliationPending.determinismState.commandHistory
    .map((entry) => entry.intent)
    .filter((intent) => intent.kind === 'schedule-activity')
  expect(pendingIntents.map((intent) => intent.activityType)).toEqual(['upsertIngestion', 'reconcileAtlasRepository'])

  const reconciliationResult = { repository: input.repository, ref: input.ref, commit: input.commit }
  const reconciliationCompleted = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: reconciliationPending.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-2', { status: 'completed', value: reconciliationResult }],
    ]),
  })

  expect(reconciliationCompleted.completion).toBe('pending')
  const completedIntent = reconciliationCompleted.determinismState.commandHistory[3]?.intent
  expect(completedIntent?.kind).toBe('schedule-activity')
  if (completedIntent?.kind !== 'schedule-activity') throw new Error('expected completed ingestion upsert')
  expect(completedIntent.activityType).toBe('upsertIngestion')
  expect(completedIntent.input).toEqual([
    { deliveryId: input.eventDeliveryId, workflowId: 'test-workflow-id', status: 'completed' },
  ])

  const terminal = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: reconciliationCompleted.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-2', { status: 'completed', value: reconciliationResult }],
      ['activity-3', { status: 'completed', value: { ingestionId: 'ingestion-1' } }],
    ]),
  })

  expect(terminal.completion).toBe('completed')
  expect(terminal.result).toEqual(reconciliationResult)
})

test('reconcileAtlasRepository consumes the legacy failed upsert before correcting it', async () => {
  const { executor } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab',
    repository: 'proompteng/lab',
    ref: 'main',
    commit: 'abcdef1234567890abcdef1234567890abcdef1234',
    eventDeliveryId: 'delivery-legacy',
  }
  const runningUpsertCompleted = new Map<string, ActivityResolution>([
    ['activity-0', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
  ])

  const initial = await execute(executor, { workflowType: 'reconcileAtlasRepository', arguments: input })
  const patchedPending = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: initial.determinismState,
    activityResults: runningUpsertCompleted,
  })
  const patchedReconcileIntent = patchedPending.determinismState.commandHistory
    .map((entry) => entry.intent)
    .find((intent) => intent.kind === 'schedule-activity' && intent.activityType === 'reconcileAtlasRepository')
  if (patchedReconcileIntent?.kind !== 'schedule-activity') throw new Error('expected reconciliation intent')

  const legacyReconcileIntent = {
    ...patchedReconcileIntent,
    id: 'schedule-activity-1',
    sequence: 1,
    activityId: 'activity-1',
  }
  const legacyPending = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: {
      ...initial.determinismState,
      commandHistory: [...initial.determinismState.commandHistory, { intent: legacyReconcileIntent }],
    },
    activityResults: runningUpsertCompleted,
  })

  expect(legacyPending.completion).toBe('pending')
  const legacyFailedIntent = legacyPending.determinismState.commandHistory[2]?.intent
  expect(legacyFailedIntent?.kind).toBe('schedule-activity')
  if (legacyFailedIntent?.kind !== 'schedule-activity') throw new Error('expected legacy failed ingestion upsert')
  expect(legacyFailedIntent.input).toEqual([
    {
      deliveryId: input.eventDeliveryId,
      workflowId: 'test-workflow-id',
      status: 'failed',
      error: 'Workflow blocked: Activity activity-1 pending',
    },
  ])

  const reconciliationResult = { repository: input.repository, ref: input.ref, commit: input.commit }
  const legacyCorrecting = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: legacyPending.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-1', { status: 'completed', value: reconciliationResult }],
      ['activity-2', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
    ]),
  })

  expect(legacyCorrecting.completion).toBe('pending')
  const correctedIntent = legacyCorrecting.determinismState.commandHistory[3]?.intent
  expect(correctedIntent?.kind).toBe('schedule-activity')
  if (correctedIntent?.kind !== 'schedule-activity') throw new Error('expected corrected ingestion upsert')
  expect(correctedIntent.input).toEqual([
    {
      deliveryId: input.eventDeliveryId,
      workflowId: 'test-workflow-id',
      status: 'completed',
      correctLegacyPendingFailure: true,
    },
  ])

  const terminal = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: legacyCorrecting.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-1', { status: 'completed', value: reconciliationResult }],
      ['activity-2', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
      ['activity-3', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
    ]),
  })

  expect(terminal.completion).toBe('completed')
  expect(terminal.result).toEqual(reconciliationResult)

  const realFailure = new Error('real reconciliation failure')
  const legacyFailing = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: legacyPending.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-1', { status: 'failed', error: realFailure }],
      ['activity-2', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
    ]),
  })

  expect(legacyFailing.completion).toBe('pending')
  const realFailureIntent = legacyFailing.determinismState.commandHistory[3]?.intent
  expect(realFailureIntent?.kind).toBe('schedule-activity')
  if (realFailureIntent?.kind !== 'schedule-activity') throw new Error('expected real failure ingestion upsert')
  expect(realFailureIntent.input).toEqual([
    {
      deliveryId: input.eventDeliveryId,
      workflowId: 'test-workflow-id',
      status: 'failed',
      error: realFailure.message,
      correctLegacyPendingFailure: true,
    },
  ])

  const failedTerminal = await execute(executor, {
    workflowType: 'reconcileAtlasRepository',
    arguments: input,
    determinismState: legacyFailing.determinismState,
    activityResults: new Map<string, ActivityResolution>([
      ...runningUpsertCompleted,
      ['activity-1', { status: 'failed', error: realFailure }],
      ['activity-2', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
      ['activity-3', { status: 'completed', value: { ingestionId: 'ingestion-legacy' } }],
    ]),
  })

  expect(failedTerminal.completion).toBe('failed')
  expect((failedTerminal.failure as Error).message).toContain(realFailure.message)
})

test('only the authoritative repository reconciliation workflow is registered for Atlas ingestion', () => {
  const { registry } = makeExecutor()
  const names = registry.list().map((definition) => definition.name)
  expect(names).toContain('reconcileAtlasRepository')
  expect(names).not.toContain('enrichFile')
  expect(names).not.toContain('enrichRepository')
})
