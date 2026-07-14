import { expect, test } from 'bun:test'
import type {
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
  expect(output.commands).toHaveLength(1)
  const schedule = output.commands[0]
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

test('only the authoritative repository reconciliation workflow is registered for Atlas ingestion', () => {
  const { registry } = makeExecutor()
  const names = registry.list().map((definition) => definition.name)
  expect(names).toContain('reconcileAtlasRepository')
  expect(names).not.toContain('enrichFile')
  expect(names).not.toContain('enrichRepository')
})
