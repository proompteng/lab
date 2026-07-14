import { afterEach, expect, test } from 'bun:test'

import type { TemporalConfig } from '../../src/config'
import { RoutingConfigUpdateState } from '../../src/proto/temporal/api/enums/v1/task_queue_pb'
import {
  alignWorkerDeploymentRouting,
  extractCurrentDeploymentBuildId,
  isRoutingUpdateComplete,
  isTransientRoutingAlignmentError,
  resolveWorkerDeploymentName,
} from '../../src/worker/deployment-routing'

const originalDeploymentName = process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME

afterEach(() => {
  if (originalDeploymentName === undefined) {
    delete process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME
  } else {
    process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME = originalDeploymentName
  }
})

const config = {
  address: 'temporal.example:7233',
  namespace: 'default',
  taskQueue: 'bumba',
  workerBuildId: 'bumba@new',
} as TemporalConfig

const deployment = (buildId: string, state: RoutingConfigUpdateState) =>
  ({
    workerDeploymentInfo: {
      routingConfig: {
        currentDeploymentVersion: { deploymentName: 'bumba-deployment', buildId },
        currentVersion: `bumba-deployment.${buildId}`,
      },
      routingConfigUpdateState: state,
    },
  }) as never

test('worker routing reports an already-propagated current build without changing it', async () => {
  let setCalls = 0
  const result = await alignWorkerDeploymentRouting(config, {
    deployments: {
      describeWorkerDeployment: async () => deployment('bumba@new', RoutingConfigUpdateState.COMPLETED),
      setWorkerDeploymentCurrentVersion: async () => {
        setCalls += 1
        return {} as never
      },
    },
  })

  expect(result).toEqual({
    deploymentName: 'bumba-deployment',
    previousBuildId: 'bumba@new',
    buildId: 'bumba@new',
    changed: false,
  })
  expect(setCalls).toBe(0)
})

test('worker routing waits for propagation after selecting the active build', async () => {
  const responses = [
    deployment('bumba@old', RoutingConfigUpdateState.COMPLETED),
    deployment('bumba@new', RoutingConfigUpdateState.IN_PROGRESS),
    deployment('bumba@new', RoutingConfigUpdateState.COMPLETED),
  ]
  const setRequests: unknown[] = []

  const result = await alignWorkerDeploymentRouting(config, {
    deployments: {
      describeWorkerDeployment: async () => responses.shift() ?? deployment('bumba@new', 2),
      setWorkerDeploymentCurrentVersion: async (request) => {
        setRequests.push(request)
        return {} as never
      },
    },
    identity: `bumba-worker/${process.pid}`,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  })

  expect(result).toEqual({
    deploymentName: 'bumba-deployment',
    previousBuildId: 'bumba@old',
    buildId: 'bumba@new',
    changed: true,
  })
  expect(setRequests).toEqual([
    {
      deploymentName: 'bumba-deployment',
      buildId: 'bumba@new',
      allowNoPollers: false,
      ignoreMissingTaskQueues: false,
      identity: `bumba-worker/${process.pid}`,
    },
  ])
})

test('worker routing retries no-poller errors and fails closed at its deadline', async () => {
  let now = 0
  let attempts = 0

  await expect(
    alignWorkerDeploymentRouting(config, {
      deployments: {
        describeWorkerDeployment: async () => {
          attempts += 1
          throw new Error('failed precondition: no pollers for build id')
        },
        setWorkerDeploymentCurrentVersion: async () => ({}) as never,
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      timeoutMs: 3,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow("Timed out after 3ms aligning Temporal worker deployment 'bumba-deployment'")
  expect(attempts).toBe(3)
})

test('worker routing resolves deployment name and propagation state explicitly', () => {
  process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME = 'override-deployment'
  expect(resolveWorkerDeploymentName(config)).toBe('override-deployment')
  expect(extractCurrentDeploymentBuildId(deployment('bumba@new', 2))).toBe('bumba@new')
  expect(isRoutingUpdateComplete(deployment('bumba@new', 2))).toBe(true)
  expect(isRoutingUpdateComplete(deployment('bumba@new', 1))).toBe(false)
  expect(isTransientRoutingAlignmentError(new Error('permission denied'))).toBe(false)
})
