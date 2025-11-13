import { expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import type { TemporalConfig } from '../src/config'
import { registerWorkerBuildIdCompatibility } from '../src/worker/build-id'
import type {
  UpdateWorkerBuildIdCompatibilityRequest,
} from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkerVersioningMode } from '../src/proto/temporal/api/enums/v1/deployment_pb'
import { VersioningBehavior } from '../src/proto/temporal/api/enums/v1/workflow_pb'
import { WorkerRuntime, type WorkflowServiceClient } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'

test('registers a build ID when the RPC succeeds', async () => {
  const requests: UpdateWorkerBuildIdCompatibilityRequest[] = []
  const service = {
    async getWorkerBuildIdCompatibility() {
      return {}
    },
    async updateWorkerBuildIdCompatibility(request: UpdateWorkerBuildIdCompatibilityRequest) {
      requests.push(request)
      return {}
    },
  }

  const info: string[] = []
  const originalInfo = console.info
  console.info = (...args: unknown[]) => info.push(args.join(' '))
  try {
    await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id')
    expect(requests).toHaveLength(1)
    expect(requests[0].namespace).toBe('namespace')
    expect(requests[0].taskQueue).toBe('task-queue')
    expect(requests[0].operation.case).toBe('addNewBuildIdInNewDefaultSet')
    expect(info.some((value) => value.includes('build ID build-id'))).toBeTrue()
  } finally {
    console.info = originalInfo
  }
})

test('retries transient failures before succeeding', async () => {
  const attempts: number[] = []
  const service = {
    async getWorkerBuildIdCompatibility() {
      return {}
    },
    async updateWorkerBuildIdCompatibility() {
      attempts.push(attempts.length + 1)
      if (attempts.length < 3) {
        throw new ConnectError('service unavailable', Code.Unavailable)
      }
      return {}
    },
  }

  const delays: number[] = []
  await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id', {
    sleep: async (ms) => delays.push(ms),
  })

  expect(attempts).toHaveLength(3)
  expect(delays).toEqual([250, 500])
})

test('warns and continues when the API is not implemented', async () => {
  const service = {
    async getWorkerBuildIdCompatibility() {
      return {}
    },
    async updateWorkerBuildIdCompatibility() {
      throw new ConnectError('not implemented', Code.Unimplemented)
    },
  }

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
  try {
    await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('worker versioning API unavailable')
  } finally {
    console.warn = originalWarn
  }
})

test('propagates fatal errors', async () => {
  const fatal = new ConnectError('invalid', Code.InvalidArgument)
  const service = {
    async getWorkerBuildIdCompatibility() {
      return {}
    },
    async updateWorkerBuildIdCompatibility() {
      throw fatal
    },
  }

  await expect(
    registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id'),
  ).rejects.toBe(fatal)
})

const noopWorkflows = [defineWorkflow('noopWorkflow', () => Effect.succeed('ok'))]

const createTestConfig = (overrides: Partial<TemporalConfig> = {}): TemporalConfig => ({
  host: '127.0.0.1',
  port: 7233,
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'test-task-queue',
  allowInsecureTls: true,
  workerIdentity: 'test-worker',
  workerIdentityPrefix: 'test',
  workerWorkflowConcurrency: 1,
  workerActivityConcurrency: 1,
  workerStickyCacheSize: 0,
  workerStickyTtlMs: 0,
  activityHeartbeatIntervalMs: 1_000,
  activityHeartbeatRpcTimeoutMs: 1_000,
  workerDeploymentName: 'test-deployment',
  workerBuildId: 'test-build-id',
  ...overrides,
})

const withWorkflowService = (service: Partial<WorkflowServiceClient>): WorkflowServiceClient =>
  service as WorkflowServiceClient

test('WorkerRuntime registers build IDs before pollers start when worker versioning is supported', async () => {
  const capabilityRequests: unknown[] = []
  const registrationRequests: unknown[] = []
  const workflowService = withWorkflowService({
    async getWorkerBuildIdCompatibility(request) {
      capabilityRequests.push(request)
      return {}
    },
    async updateWorkerBuildIdCompatibility(request) {
      registrationRequests.push(request)
      return {}
    },
  })

  const config = createTestConfig({ taskQueue: 'versioned-queue-1' })
  let runtime: WorkerRuntime | null = null
  try {
    runtime = await WorkerRuntime.create({
      config,
      workflows: noopWorkflows,
      workflowService,
      deployment: {
        name: config.workerDeploymentName,
        buildId: config.workerBuildId,
        versioningMode: WorkerVersioningMode.VERSIONED,
        versioningBehavior: VersioningBehavior.PINNED,
      },
    })

    expect(capabilityRequests).toHaveLength(1)
    expect(registrationRequests).toHaveLength(1)
  } finally {
    await runtime?.shutdown()
  }
})

test('WorkerRuntime logs a warning and skips registration when worker versioning APIs are missing', async () => {
  const capabilityRequests: unknown[] = []
  let updateCalled = false
  const workflowService = withWorkflowService({
    async getWorkerBuildIdCompatibility(request) {
      capabilityRequests.push(request)
      throw new ConnectError('not implemented', Code.Unimplemented)
    },
    async updateWorkerBuildIdCompatibility() {
      updateCalled = true
      return {}
    },
  })

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '))

  const config = createTestConfig({ taskQueue: 'versioned-queue-2' })
  let runtime: WorkerRuntime | null = null
  try {
    runtime = await WorkerRuntime.create({
      config,
      workflows: noopWorkflows,
      workflowService,
      deployment: {
        name: config.workerDeploymentName,
        buildId: config.workerBuildId,
        versioningMode: WorkerVersioningMode.VERSIONED,
        versioningBehavior: VersioningBehavior.PINNED,
      },
    })

    expect(capabilityRequests).toHaveLength(1)
    expect(updateCalled).toBeFalse()
    expect(warnings.some((line) => line.includes('skipping worker build ID registration'))).toBeTrue()
  } finally {
    console.warn = originalWarn
    await runtime?.shutdown()
  }
})
