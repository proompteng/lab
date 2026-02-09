import { Effect } from 'effect'

import type { TemporalConfig } from '../../src/config'
import type { ObservabilityServices } from '../../src/observability'

export const createTestTemporalConfig = (overrides: Partial<TemporalConfig> = {}): TemporalConfig => ({
  host: '127.0.0.1',
  port: 7233,
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'replay-fixtures',
  apiKey: undefined,
  tls: undefined,
  allowInsecureTls: true,
  workerIdentity: 'test-worker',
  workerIdentityPrefix: 'test',
  showStackTraceSources: false,
  workerWorkflowConcurrency: 1,
  workerActivityConcurrency: 1,
  workerStickyCacheSize: 1,
  workerStickyTtlMs: 1,
  stickySchedulingEnabled: true,
  determinismMarkerMode: 'delta',
  determinismMarkerIntervalTasks: 10,
  determinismMarkerFullSnapshotIntervalTasks: 50,
  determinismMarkerSkipUnchanged: true,
  determinismMarkerMaxDetailBytes: 1_800_000,
  workflowGuards: 'warn',
  workflowLint: 'warn',
  activityHeartbeatIntervalMs: 1,
  activityHeartbeatRpcTimeoutMs: 1,
  workerDeploymentName: undefined,
  workerBuildId: undefined,
  logLevel: 'info',
  logFormat: 'pretty',
  metricsExporter: { type: 'in-memory' },
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

export const createObservabilityStub = () => {
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []
  let counterIncrements = 0
  let flushes = 0
  const services: ObservabilityServices = {
    logger: {
      log: (level, message, fields) =>
        Effect.sync(() => {
          logs.push({ level, message, fields: fields as Record<string, unknown> })
        }),
    },
    metricsRegistry: {
      counter: () =>
        Effect.succeed({
          inc: () =>
            Effect.sync(() => {
              counterIncrements += 1
            }),
        }),
      histogram: () =>
        Effect.succeed({
          observe: () => Effect.void,
        }),
    },
    metricsExporter: {
      recordCounter: () => Effect.void,
      recordHistogram: () => Effect.void,
      flush: () =>
        Effect.sync(() => {
          flushes += 1
        }),
    },
  }

  return {
    services,
    logs,
    getCounterIncrements: () => counterIncrements,
    getFlushes: () => flushes,
  }
}
