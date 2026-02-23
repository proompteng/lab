import { expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { createClient, type CallOptions } from '@connectrpc/connect'

import { createTemporalClient, temporalCallOptions } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import {
  SchedulePatchSchema,
  ScheduleSchema,
} from '../../src/proto/temporal/api/schedule/v1/message_pb'
import { OperatorService } from '../../src/proto/temporal/api/operatorservice/v1/service_pb'
import { WorkflowService } from '../../src/proto/temporal/api/workflowservice/v1/service_pb'

const makeSchedule = (taskQueue: string) =>
  create(ScheduleSchema, {
    spec: {
      interval: [{ interval: { seconds: 60n, nanos: 0 } }],
    },
    action: {
      case: 'startWorkflow',
      value: {
        workflowType: { name: 'testWorkflow' },
        taskQueue: { name: taskQueue },
      },
    },
  })

const makeTimestamp = (seconds: bigint) => ({ seconds, nanos: 0 })

type CallRecord = {
  request: Record<string, unknown>
  headers: Record<string, string>
}

const normalizeHeaders = (options?: CallOptions): Record<string, string> => ({
  ...((options?.headers as Record<string, string>) ?? {}),
})

const recordCall = (
  calls: Map<string, CallRecord[]>,
  method: string,
  request: Record<string, unknown>,
  options?: CallOptions,
) => {
  const entry: CallRecord = {
    request,
    headers: normalizeHeaders(options),
  }
  const existing = calls.get(method) ?? []
  existing.push(entry)
  calls.set(method, existing)
}

const lastCall = (calls: Map<string, CallRecord[]>, method: string): CallRecord | undefined => {
  const entries = calls.get(method)
  if (!entries || entries.length === 0) {
    return undefined
  }
  return entries[entries.length - 1]
}

test('schedule client forwards schedule lifecycle RPCs with call options', async () => {
  const config = await loadTemporalConfig()
  type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>
  const calls = new Map<string, CallRecord[]>()

  const workflowService = {
    createSchedule: async (request, options) => {
      recordCall(calls, 'createSchedule', request, options)
      return {}
    },
    describeSchedule: async (request, options) => {
      recordCall(calls, 'describeSchedule', request, options)
      return {}
    },
    updateSchedule: async (request, options) => {
      recordCall(calls, 'updateSchedule', request, options)
      return {}
    },
    patchSchedule: async (request, options) => {
      recordCall(calls, 'patchSchedule', request, options)
      return {}
    },
    listSchedules: async (request, options) => {
      recordCall(calls, 'listSchedules', request, options)
      return {}
    },
    listScheduleMatchingTimes: async (request, options) => {
      recordCall(calls, 'listScheduleMatchingTimes', request, options)
      return {}
    },
    deleteSchedule: async (request, options) => {
      recordCall(calls, 'deleteSchedule', request, options)
      return {}
    },
  } as unknown as WorkflowServiceClient

  const { client } = await createTemporalClient({ config, workflowService })
  const callOptions = temporalCallOptions({ headers: { 'x-call-test': 'ok' } })

  try {
    const scheduleId = 'schedule-test'
    const schedule = makeSchedule(config.taskQueue)

    await client.schedules.create({ scheduleId, schedule }, callOptions)
    expect(lastCall(calls, 'createSchedule')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'createSchedule')?.request.scheduleId).toBe(scheduleId)
    expect(lastCall(calls, 'createSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.describe({ scheduleId }, callOptions)
    expect(lastCall(calls, 'describeSchedule')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'describeSchedule')?.request.scheduleId).toBe(scheduleId)
    expect(lastCall(calls, 'describeSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.update({
      scheduleId,
      schedule,
      conflictToken: new Uint8Array(),
    }, callOptions)
    expect(lastCall(calls, 'updateSchedule')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'updateSchedule')?.request.scheduleId).toBe(scheduleId)
    expect(lastCall(calls, 'updateSchedule')?.headers['x-call-test']).toBe('ok')

    const patch = create(SchedulePatchSchema, { pause: 'paused' })
    await client.schedules.patch({ scheduleId, patch }, callOptions)
    expect(lastCall(calls, 'patchSchedule')?.request.scheduleId).toBe(scheduleId)
    expect((lastCall(calls, 'patchSchedule')?.request.patch as Record<string, unknown>)?.pause).toBe('paused')
    expect(lastCall(calls, 'patchSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.list(undefined, callOptions)
    expect(lastCall(calls, 'listSchedules')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'listSchedules')?.headers['x-call-test']).toBe('ok')

    await client.schedules.listMatchingTimes(
      {
        scheduleId,
        startTime: makeTimestamp(0n),
        endTime: makeTimestamp(60n),
      },
      callOptions,
    )
    expect(lastCall(calls, 'listScheduleMatchingTimes')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'listScheduleMatchingTimes')?.request.scheduleId).toBe(scheduleId)
    expect(lastCall(calls, 'listScheduleMatchingTimes')?.headers['x-call-test']).toBe('ok')

    await client.schedules.delete({ scheduleId }, callOptions)
    expect(lastCall(calls, 'deleteSchedule')?.request.namespace).toBe(config.namespace)
    expect(lastCall(calls, 'deleteSchedule')?.request.scheduleId).toBe(scheduleId)
    expect(lastCall(calls, 'deleteSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.trigger({ scheduleId }, callOptions)
    const triggerPatch = lastCall(calls, 'patchSchedule')?.request.patch as Record<string, unknown>
    expect(triggerPatch.triggerImmediately).toBeTruthy()
    expect(lastCall(calls, 'patchSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.backfill({
      scheduleId,
      backfillRequest: [{
        startTime: makeTimestamp(0n),
        endTime: makeTimestamp(120n),
      }],
    }, callOptions)
    const backfillPatch = lastCall(calls, 'patchSchedule')?.request.patch as Record<string, unknown>
    expect(Array.isArray(backfillPatch.backfillRequest)).toBe(true)
    expect(lastCall(calls, 'patchSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.pause({ scheduleId, reason: 'stop' }, callOptions)
    const pausePatch = lastCall(calls, 'patchSchedule')?.request.patch as Record<string, unknown>
    expect(pausePatch.pause).toBe('stop')
    expect(lastCall(calls, 'patchSchedule')?.headers['x-call-test']).toBe('ok')

    await client.schedules.unpause({ scheduleId, reason: 'resume' }, callOptions)
    const unpausePatch = lastCall(calls, 'patchSchedule')?.request.patch as Record<string, unknown>
    expect(unpausePatch.unpause).toBe('resume')
    expect(lastCall(calls, 'patchSchedule')?.headers['x-call-test']).toBe('ok')
  } finally {
    await client.shutdown()
  }
})

test('workflow, worker, and deployment ops call WorkflowService RPCs with defaults', async () => {
  const config = await loadTemporalConfig()
  type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>
  const calls = new Map<string, CallRecord[]>()

  const workflowService = {
    updateWorkflowExecutionOptions: async (request, options) => {
      recordCall(calls, 'updateWorkflowExecutionOptions', request, options)
      return {}
    },
    pauseWorkflowExecution: async (request, options) => {
      recordCall(calls, 'pauseWorkflowExecution', request, options)
      return {}
    },
    unpauseWorkflowExecution: async (request, options) => {
      recordCall(calls, 'unpauseWorkflowExecution', request, options)
      return {}
    },
    resetStickyTaskQueue: async (request, options) => {
      recordCall(calls, 'resetStickyTaskQueue', request, options)
      return {}
    },
    listWorkers: async (request, options) => {
      recordCall(calls, 'listWorkers', request, options)
      return {}
    },
    describeWorker: async (request, options) => {
      recordCall(calls, 'describeWorker', request, options)
      return {}
    },
    fetchWorkerConfig: async (request, options) => {
      recordCall(calls, 'fetchWorkerConfig', request, options)
      return {}
    },
    updateWorkerConfig: async (request, options) => {
      recordCall(calls, 'updateWorkerConfig', request, options)
      return {}
    },
    updateTaskQueueConfig: async (request, options) => {
      recordCall(calls, 'updateTaskQueueConfig', request, options)
      return {}
    },
    getWorkerVersioningRules: async (request, options) => {
      recordCall(calls, 'getWorkerVersioningRules', request, options)
      return {}
    },
    updateWorkerVersioningRules: async (request, options) => {
      recordCall(calls, 'updateWorkerVersioningRules', request, options)
      return {}
    },
    listWorkerDeployments: async (request, options) => {
      recordCall(calls, 'listWorkerDeployments', request, options)
      return {}
    },
    describeWorkerDeployment: async (request, options) => {
      recordCall(calls, 'describeWorkerDeployment', request, options)
      return {}
    },
    listDeployments: async (request, options) => {
      recordCall(calls, 'listDeployments', request, options)
      return {}
    },
    describeDeployment: async (request, options) => {
      recordCall(calls, 'describeDeployment', request, options)
      return {}
    },
    getCurrentDeployment: async (request, options) => {
      recordCall(calls, 'getCurrentDeployment', request, options)
      return {}
    },
    setCurrentDeployment: async (request, options) => {
      recordCall(calls, 'setCurrentDeployment', request, options)
      return {}
    },
    getDeploymentReachability: async (request, options) => {
      recordCall(calls, 'getDeploymentReachability', request, options)
      return {}
    },
    setWorkerDeploymentCurrentVersion: async (request, options) => {
      recordCall(calls, 'setWorkerDeploymentCurrentVersion', request, options)
      return {}
    },
    setWorkerDeploymentRampingVersion: async (request, options) => {
      recordCall(calls, 'setWorkerDeploymentRampingVersion', request, options)
      return {}
    },
    updateWorkerDeploymentVersionMetadata: async (request, options) => {
      recordCall(calls, 'updateWorkerDeploymentVersionMetadata', request, options)
      return {}
    },
    deleteWorkerDeploymentVersion: async (request, options) => {
      recordCall(calls, 'deleteWorkerDeploymentVersion', request, options)
      return {}
    },
    deleteWorkerDeployment: async (request, options) => {
      recordCall(calls, 'deleteWorkerDeployment', request, options)
      return {}
    },
    setWorkerDeploymentManager: async (request, options) => {
      recordCall(calls, 'setWorkerDeploymentManager', request, options)
      return {}
    },
  } as unknown as WorkflowServiceClient

  const { client } = await createTemporalClient({ config, workflowService })
  const callOptions = temporalCallOptions({ headers: { 'x-call-test': 'ok' } })

  try {
    await client.workflowOps.updateExecutionOptions({}, callOptions)
    expect(lastCall(calls, 'updateWorkflowExecutionOptions')?.request.namespace).toBe(config.namespace)

    await client.workflowOps.pauseExecution({}, callOptions)
    expect(lastCall(calls, 'pauseWorkflowExecution')?.request.namespace).toBe(config.namespace)

    await client.workflowOps.unpauseExecution({}, callOptions)
    expect(lastCall(calls, 'unpauseWorkflowExecution')?.request.namespace).toBe(config.namespace)

    await client.workflowOps.resetStickyTaskQueue({}, callOptions)
    expect(lastCall(calls, 'resetStickyTaskQueue')?.request.namespace).toBe(config.namespace)

    await client.workerOps.list(undefined, callOptions)
    expect(lastCall(calls, 'listWorkers')?.request.namespace).toBe(config.namespace)

    await client.workerOps.describe({ workerInstanceKey: 'worker-1' }, callOptions)
    expect(lastCall(calls, 'describeWorker')?.request.namespace).toBe(config.namespace)

    await client.workerOps.fetchConfig({ identity: 'identity' }, callOptions)
    expect(lastCall(calls, 'fetchWorkerConfig')?.request.namespace).toBe(config.namespace)

    await client.workerOps.updateConfig({ identity: 'identity' }, callOptions)
    expect(lastCall(calls, 'updateWorkerConfig')?.request.namespace).toBe(config.namespace)

    await client.workerOps.updateTaskQueueConfig({ taskQueue: 'tq' }, callOptions)
    expect(lastCall(calls, 'updateTaskQueueConfig')?.request.namespace).toBe(config.namespace)

    await client.workerOps.getVersioningRules({ taskQueue: 'tq' }, callOptions)
    expect(lastCall(calls, 'getWorkerVersioningRules')?.request.namespace).toBe(config.namespace)

    await client.workerOps.updateVersioningRules({ taskQueue: 'tq' }, callOptions)
    expect(lastCall(calls, 'updateWorkerVersioningRules')?.request.namespace).toBe(config.namespace)

    await client.deployments.listWorkerDeployments(undefined, callOptions)
    expect(lastCall(calls, 'listWorkerDeployments')?.request.namespace).toBe(config.namespace)

    await client.deployments.describeWorkerDeployment({ deploymentName: 'deploy-1' }, callOptions)
    expect(lastCall(calls, 'describeWorkerDeployment')?.request.namespace).toBe(config.namespace)

    await client.deployments.listDeployments(undefined, callOptions)
    expect(lastCall(calls, 'listDeployments')?.request.namespace).toBe(config.namespace)

    await client.deployments.describeDeployment(
      { deployment: { seriesName: 'series-1', buildId: 'build-1' } },
      callOptions,
    )
    expect(lastCall(calls, 'describeDeployment')?.request.namespace).toBe(config.namespace)

    await client.deployments.getCurrentDeployment({ seriesName: 'series-1' }, callOptions)
    expect(lastCall(calls, 'getCurrentDeployment')?.request.namespace).toBe(config.namespace)

    await client.deployments.setCurrentDeployment(
      { deployment: { seriesName: 'series-1', buildId: 'build-2' } },
      callOptions,
    )
    expect(lastCall(calls, 'setCurrentDeployment')?.request.namespace).toBe(config.namespace)

    await client.deployments.getDeploymentReachability(
      { deployment: { seriesName: 'series-1', buildId: 'build-3' } },
      callOptions,
    )
    expect(lastCall(calls, 'getDeploymentReachability')?.request.namespace).toBe(config.namespace)

    await client.deployments.setWorkerDeploymentCurrentVersion(
      { deploymentName: 'deploy-5', buildId: 'build-5' },
      callOptions,
    )
    const setCurrentVersionCall = lastCall(calls, 'setWorkerDeploymentCurrentVersion')
    expect(setCurrentVersionCall?.request.namespace).toBe(config.namespace)
    expect(setCurrentVersionCall?.request.version).toBe('')
    expect(setCurrentVersionCall?.request.conflictToken).toEqual(new Uint8Array())

    await client.deployments.setWorkerDeploymentRampingVersion(
      { deploymentName: 'deploy-6', buildId: 'build-6', percentage: 10 },
      callOptions,
    )
    const setRampingVersionCall = lastCall(calls, 'setWorkerDeploymentRampingVersion')
    expect(setRampingVersionCall?.request.namespace).toBe(config.namespace)
    expect(setRampingVersionCall?.request.version).toBe('')
    expect(setRampingVersionCall?.request.conflictToken).toEqual(new Uint8Array())

    await client.deployments.updateWorkerDeploymentVersionMetadata(
      { deploymentVersion: { deploymentName: 'deploy-7', buildId: 'build-7' }, version: 'v3' },
      callOptions,
    )
    expect(lastCall(calls, 'updateWorkerDeploymentVersionMetadata')?.request.namespace).toBe(config.namespace)

    await client.deployments.deleteWorkerDeploymentVersion(
      { deploymentVersion: { deploymentName: 'deploy-8', buildId: 'build-8' }, version: 'v4' },
      callOptions,
    )
    expect(lastCall(calls, 'deleteWorkerDeploymentVersion')?.request.namespace).toBe(config.namespace)

    await client.deployments.deleteWorkerDeployment({ deploymentName: 'deploy-9' }, callOptions)
    expect(lastCall(calls, 'deleteWorkerDeployment')?.request.namespace).toBe(config.namespace)

    await client.deployments.setWorkerDeploymentManager(
      { deploymentName: 'deploy-10', newManagerIdentity: { case: 'managerIdentity', value: 'mgr' } },
      callOptions,
    )
    expect(lastCall(calls, 'setWorkerDeploymentManager')?.request.namespace).toBe(config.namespace)

    const operations = [
      'updateWorkflowExecutionOptions',
      'pauseWorkflowExecution',
      'unpauseWorkflowExecution',
      'resetStickyTaskQueue',
      'listWorkers',
      'describeWorker',
      'fetchWorkerConfig',
      'updateWorkerConfig',
      'updateTaskQueueConfig',
      'getWorkerVersioningRules',
      'updateWorkerVersioningRules',
      'listWorkerDeployments',
      'describeWorkerDeployment',
      'listDeployments',
      'describeDeployment',
      'getCurrentDeployment',
      'setCurrentDeployment',
      'getDeploymentReachability',
      'setWorkerDeploymentCurrentVersion',
      'setWorkerDeploymentRampingVersion',
      'updateWorkerDeploymentVersionMetadata',
      'deleteWorkerDeploymentVersion',
      'deleteWorkerDeployment',
      'setWorkerDeploymentManager',
    ]

    for (const operation of operations) {
      expect(lastCall(calls, operation)?.headers['x-call-test']).toBe('ok')
    }
  } finally {
    await client.shutdown()
  }
})

test('operator client forwards search attribute and nexus endpoint ops', async () => {
  const config = await loadTemporalConfig()
  type OperatorServiceClient = ReturnType<typeof createClient<typeof OperatorService>>
  const calls = new Map<string, CallRecord[]>()

  const operatorService = {
    addSearchAttributes: async (request, options) => {
      recordCall(calls, 'addSearchAttributes', request, options)
      return {}
    },
    removeSearchAttributes: async (request, options) => {
      recordCall(calls, 'removeSearchAttributes', request, options)
      return {}
    },
    listSearchAttributes: async (request, options) => {
      recordCall(calls, 'listSearchAttributes', request, options)
      return {}
    },
    createNexusEndpoint: async (request, options) => {
      recordCall(calls, 'createNexusEndpoint', request, options)
      return {}
    },
    updateNexusEndpoint: async (request, options) => {
      recordCall(calls, 'updateNexusEndpoint', request, options)
      return {}
    },
    deleteNexusEndpoint: async (request, options) => {
      recordCall(calls, 'deleteNexusEndpoint', request, options)
      return {}
    },
    getNexusEndpoint: async (request, options) => {
      recordCall(calls, 'getNexusEndpoint', request, options)
      return {}
    },
    listNexusEndpoints: async (request, options) => {
      recordCall(calls, 'listNexusEndpoints', request, options)
      return {}
    },
  } as unknown as OperatorServiceClient

  const { client } = await createTemporalClient({ config, operatorService })
  const callOptions = temporalCallOptions({ headers: { 'x-call-test': 'ok' } })

  try {
    await client.operator.addSearchAttributes({ searchAttributes: { CustomKeywordField: 1 } }, callOptions)
    expect(lastCall(calls, 'addSearchAttributes')?.request.namespace).toBe(config.namespace)

    await client.operator.removeSearchAttributes({ searchAttributes: ['CustomKeywordField'] }, callOptions)
    expect(lastCall(calls, 'removeSearchAttributes')?.request.namespace).toBe(config.namespace)

    await client.operator.listSearchAttributes({}, callOptions)
    expect(lastCall(calls, 'listSearchAttributes')?.request.namespace).toBe(config.namespace)

    await client.operator.createNexusEndpoint({ spec: { name: 'endpoint-1' } }, callOptions)
    await client.operator.updateNexusEndpoint({ id: 'endpoint-1', version: 1n }, callOptions)
    await client.operator.deleteNexusEndpoint({ id: 'endpoint-1' }, callOptions)
    await client.operator.getNexusEndpoint({ id: 'endpoint-1' }, callOptions)
    await client.operator.listNexusEndpoints(undefined, callOptions)

    const operations = [
      'addSearchAttributes',
      'removeSearchAttributes',
      'listSearchAttributes',
      'createNexusEndpoint',
      'updateNexusEndpoint',
      'deleteNexusEndpoint',
      'getNexusEndpoint',
      'listNexusEndpoints',
    ]

    for (const operation of operations) {
      expect(lastCall(calls, operation)?.headers['x-call-test']).toBe('ok')
    }
  } finally {
    await client.shutdown()
  }
})
