import { expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import { cloneMetricsExporterSpec, defaultMetricsExporterSpec } from '../src/observability/metrics'
import type { Logger } from '../src/observability/logger'

import type { TemporalConfig } from '../src/config'
import { registerWorkerBuildIdCompatibility } from '../src/worker/build-id'
import type {
  UpdateWorkerBuildIdCompatibilityRequest,
} from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkerVersioningMode } from '../src/proto/temporal/api/enums/v1/deployment_pb'
import { VersioningBehavior } from '../src/proto/temporal/api/enums/v1/workflow_pb'
import type { WorkflowServiceClient } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'
import { createTestWorkerRuntime } from './helpers/worker-runtime'

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

  const recording = createRecordingLogger()
  await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id', {
    logger: recording.logger,
  })
  expect(requests).toHaveLength(1)
  expect(requests[0].namespace).toBe('namespace')
  expect(requests[0].taskQueue).toBe('task-queue')
  expect(requests[0].operation.case).toBe('addNewBuildIdInNewDefaultSet')
  expect(
    recording.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'registered worker build ID',
    ),
  ).toBeTrue()
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

  const recording = createRecordingLogger()
  await registerWorkerBuildIdCompatibility(service, 'namespace', 'task-queue', 'build-id', {
    logger: recording.logger,
  })
  expect(
    recording.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('worker versioning API unavailable'),
    ),
  ).toBeTrue()
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
  apiKey: undefined,
  tls: undefined,
  stickySchedulingEnabled: false,
  workerIdentity: 'test-worker',
  workerIdentityPrefix: 'test',
  showStackTraceSources: false,
  workerWorkflowConcurrency: 1,
  workerActivityConcurrency: 1,
  workerStickyCacheSize: 0,
  workerStickyTtlMs: 0,
  determinismMarkerMode: 'delta',
  determinismMarkerIntervalTasks: 10,
  determinismMarkerFullSnapshotIntervalTasks: 50,
  determinismMarkerSkipUnchanged: true,
  determinismMarkerMaxDetailBytes: 1_800_000,
  workflowGuards: 'warn',
  workflowLint: 'warn',
  activityHeartbeatIntervalMs: 1_000,
  activityHeartbeatRpcTimeoutMs: 1_000,
  workerDeploymentName: 'test-deployment',
  workerBuildId: 'test-build-id',
  logLevel: 'info',
  logFormat: 'pretty',
  metricsExporter: cloneMetricsExporterSpec(defaultMetricsExporterSpec),
  tracingInterceptorsEnabled: false,
  rpcRetryPolicy: {
    maxAttempts: 1,
    initialDelayMs: 1,
    maxDelayMs: 1,
    backoffCoefficient: 1,
    jitterFactor: 0,
    retryableStatusCodes: [],
  },
  payloadCodecs: [],
  ...overrides,
})

const withWorkflowService = (service: Partial<WorkflowServiceClient>): WorkflowServiceClient =>
  service as WorkflowServiceClient

const createRecordingLogger = () => {
  const entries: { level: string; message: string; fields?: unknown }[] = []
  const logger: Logger = {
    log(level, message, fields) {
      entries.push({ level, message, fields })
      return Effect.void
    },
  }
  return { entries, logger }
}

test('WorkerRuntime does not call build-id compatibility APIs when worker versioning is enabled', async () => {
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
  const runtime = await createTestWorkerRuntime({
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

  expect(capabilityRequests).toHaveLength(0)
  expect(registrationRequests).toHaveLength(0)
  await runtime.shutdown()
})

test('WorkerRuntime continues to start even if build-id compatibility APIs are disabled', async () => {
  const capabilityRequests: unknown[] = []
  const registrationRequests: unknown[] = []
  const workflowService = withWorkflowService({
    async getWorkerBuildIdCompatibility(request) {
      capabilityRequests.push(request)
      throw new ConnectError('disabled', Code.PermissionDenied)
    },
    async updateWorkerBuildIdCompatibility(request) {
      registrationRequests.push(request)
      throw new ConnectError('disabled', Code.PermissionDenied)
    },
  })

  const config = createTestConfig({ taskQueue: 'versioned-queue-2' })
  const runtime = await createTestWorkerRuntime({
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

  expect(capabilityRequests).toHaveLength(0)
  expect(registrationRequests).toHaveLength(0)
  await runtime.shutdown()
})
