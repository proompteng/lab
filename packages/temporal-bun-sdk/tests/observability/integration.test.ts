import { expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'
import { Cause, Effect, Exit, Option } from 'effect'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeActivityLifecycle } from '../../src/activities/lifecycle'
import { createDefaultDataConverter } from '../../src/common/payloads'
import { createObservabilityServices } from '../../src/observability'
import type { MetricsExporter } from '../../src/observability/metrics'
import { createMetricsRegistry } from '../../src/observability/metrics'
import { LogEntry, makeLogger } from '../../src/observability/logger'
import type { ActivityContext } from '../../src/worker/activity-context'
import type { WorkflowServiceClient } from '../../src/worker/runtime'

const metricsFile = () => join(tmpdir(), `observe-${Date.now()}.json`)

test('observability services log + metrics', async () => {
  const sink: LogEntry[] = []
  const customLogger = makeLogger({
    level: 'debug',
    format: 'json',
    sink: {
      write(entry) {
        sink.push(entry)
      },
    },
  })
  const target = metricsFile()
  const services = await Effect.runPromise(
    createObservabilityServices({
      logLevel: 'debug',
      logFormat: 'json',
      metrics: { type: 'file', endpoint: target },
    }, { logger: customLogger }),
  )
  const { logger, metricsRegistry, metricsExporter } = services
  const counter = await Effect.runPromise(
    metricsRegistry.counter('observability_integration_total', 'test integration runs'),
  )
  await Effect.runPromise(counter.inc())
  await Effect.runPromise(logger.log('info', 'integration test log', { stage: 'metrics' }))
  await Effect.runPromise(metricsExporter.flush())

  const content = await readFile(target, 'utf8')
  expect(content).toContain('observability_integration_total')
  expect(sink.map((entry) => entry.message)).toContain('integration test log')
})

test('activity lifecycle wiring emits logger + metric telemetry', async () => {
  const exporter = new RecordingMetricsExporter()
  const registry = createMetricsRegistry(exporter)
  const telemetryLogs: LogEntry[] = []
  const logger = makeLogger({
    level: 'debug',
    format: 'json',
    sink: {
      write(entry) {
        telemetryLogs.push(entry)
      },
    },
  })
  const heartbeatRetryCounter = await Effect.runPromise(
    registry.counter('integration_heartbeat_retries_total', 'integration heartbeat retries'),
  )
  const heartbeatFailureCounter = await Effect.runPromise(
    registry.counter('integration_heartbeat_failures_total', 'integration heartbeat failures'),
  )

  const lifecycle = await Effect.runPromise(
    makeActivityLifecycle({
      heartbeatIntervalMs: 5,
      heartbeatRpcTimeoutMs: 5,
      heartbeatRetry: {
        initialIntervalMs: 1,
        maxIntervalMs: 2,
        backoffCoefficient: 1,
        maxAttempts: 2,
        jitterRatio: 0,
      },
      observability: {
        logger,
        heartbeatRetryCounter,
        heartbeatFailureCounter,
      },
    }),
  )

  const controller = new AbortController()
  const context = createActivityLifecycleContext(controller)
  const workflowService = createFailingWorkflowService()
  const registration = await Effect.runPromise(
    lifecycle.registerHeartbeat({
      context,
      workflowService,
      taskToken: new Uint8Array([1, 2, 3]),
      identity: 'test-worker',
      namespace: 'default',
      dataConverter: createDefaultDataConverter(),
      abortController: controller,
    }),
  )

  const heartbeatExit = await Effect.runPromiseExit(registration.heartbeat(['telemetry']))
  expect(Exit.isFailure(heartbeatExit)).toBeTrue()
  if (Exit.isFailure(heartbeatExit)) {
    const failure = Cause.failureOption(heartbeatExit.cause)
    expect(Option.isSome(failure)).toBeTrue()
    if (Option.isSome(failure)) {
      const rootCause =
        failure.value instanceof ConnectError
          ? failure.value
          : typeof failure.value === 'object' && failure.value !== null && 'cause' in failure.value
            ? (failure.value as { cause?: unknown }).cause ?? failure.value
            : failure.value
      expect(rootCause).toBeInstanceOf(ConnectError)
    }
  }
  await Effect.runPromise(registration.shutdown)

  expect(exporter.getCounterValue('integration_heartbeat_retries_total')).toBeGreaterThanOrEqual(1)
  expect(exporter.getCounterValue('integration_heartbeat_failures_total')).toBe(1)
  expect(
    telemetryLogs.some((entry) => entry.level === 'warn' && entry.message === 'activity heartbeat failure'),
  ).toBeTrue()
})

const createActivityLifecycleContext = (abortController: AbortController): ActivityContext => ({
  info: {
    activityId: 'observe-activity',
    activityType: 'integration',
    workflowNamespace: 'default',
    workflowType: 'integrationWorkflow',
    workflowId: 'wf-test',
    runId: 'run-id',
    taskQueue: 'observe-queue',
    attempt: 1,
    heartbeatTimeoutMs: 1_000,
    isLocal: false,
    lastHeartbeatDetails: [],
  },
  cancellationSignal: abortController.signal,
  get isCancellationRequested() {
    return abortController.signal.aborted
  },
  async heartbeat() {},
  throwIfCancelled() {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason ?? new Error('cancelled')
    }
  },
})

const createFailingWorkflowService = (): WorkflowServiceClient =>
  ({
    async recordActivityTaskHeartbeat() {
      throw new ConnectError('transient failure', Code.Unavailable)
    },
  } as unknown as WorkflowServiceClient)

class RecordingMetricsExporter implements MetricsExporter {
  readonly #counters = new Map<string, number>()

  recordCounter(name: string, value: number, _description?: string) {
    return Effect.sync(() => {
      const current = this.#counters.get(name) ?? 0
      this.#counters.set(name, current + value)
    })
  }

  recordHistogram(_name: string, _value: number, _description?: string) {
    return Effect.void
  }

  flush() {
    return Effect.void
  }

  getCounterValue(name: string): number {
    return this.#counters.get(name) ?? 0
  }
}
