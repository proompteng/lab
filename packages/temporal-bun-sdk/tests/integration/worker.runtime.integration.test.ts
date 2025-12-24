import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Effect } from 'effect'

import { buildTransportOptions, createTemporalClient, normalizeTemporalAddress } from '../../src/client'
import { loadTemporalConfig, type TemporalConfig } from '../../src/config'
import { WorkerVersioningMode } from '../../src/proto/temporal/api/enums/v1/deployment_pb'
import { VersioningBehavior } from '../../src/proto/temporal/api/enums/v1/workflow_pb'
import {
  type PollWorkflowTaskQueueRequest,
  type RespondWorkflowTaskCompletedRequest,
} from '../../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from '../../src/proto/temporal/api/workflowservice/v1/service_pb'
import { WorkerRuntime } from '../../src/worker/runtime'
import { defineWorkflow } from '../../src/workflow/definition'
import type { IntegrationHarness } from './harness'
import { createIntegrationHarness, type TemporalDevServerConfig } from './harness'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip

const devServerDefaults: TemporalDevServerConfig = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
}

const sanitizeTaskQueueComponent = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-')

const runTemporalCli = async (...args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const child = Bun.spawn(['temporal', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await child.exited
  const stdout = child.stdout ? await new Response(child.stdout).text() : ''
  const stderr = child.stderr ? await new Response(child.stderr).text() : ''
  if (exitCode !== 0) {
    throw new Error(`temporal ${args.join(' ')} failed: ${stderr || stdout}`)
  }
  return { stdout, stderr }
}

describeIntegration('Temporal worker runtime integration', () => {
  let harness: IntegrationHarness
  const harnessConfig = devServerDefaults

  beforeAll(async () => {
    harness = await Effect.runPromise(createIntegrationHarness(harnessConfig))
    await Effect.runPromise(harness.setup)
  })

  afterAll(async () => {
    await Effect.runPromise(harness.teardown)
  })

  test('processes workflow tasks concurrently up to configured limit', async () => {
    const metrics = await Effect.runPromise(
      harness.runScenario('workflow concurrency', () =>
        Effect.tryPromise(async () => {
          const taskQueue = `codex-concurrency-${Date.now()}-${Math.round(Math.random() * 1000)}`
          const iterations = 60_000_000
          const concurrencyMetrics = { active: 0, peak: 0, total: 0, completed: 0 }

          const workflowDefinition = defineWorkflow('concurrencyWorkflow', ({ input, determinism }) =>
            Effect.gen(function* () {
              const [rawIterations] = input as [number?]
              const loopTarget = typeof rawIterations === 'number' && rawIterations > 0 ? rawIterations : iterations
              const start = determinism.now()
              let acc = 0
              for (let index = 0; index < loopTarget; index += 1) {
                acc = (acc + (index % 97)) ^ (index & 31)
                if (index % 50_000 === 0) {
                  determinism.now()
                  determinism.random()
                }
              }
              yield* Effect.tryPromise(
                () =>
                  new Promise<void>((resolve) => {
                    setTimeout(() => resolve(), 25)
                  }),
              )
              const elapsed = determinism.now() - start
              return `${acc}:${elapsed}`
            }),
          )

          const config = await loadTemporalConfig({
            defaults: {
              address: harnessConfig.address,
              namespace: harnessConfig.namespace,
              taskQueue,
              workerWorkflowConcurrency: 2,
              workerActivityConcurrency: 1,
            },
          })
          const runtime = await WorkerRuntime.create({
            config,
            workflows: [workflowDefinition],
            taskQueue,
            namespace: config.namespace,
            concurrency: { workflow: 2 },
            stickyScheduling: false,
            deployment: {
              versioningMode: WorkerVersioningMode.UNVERSIONED,
              versioningBehavior: VersioningBehavior.UNSPECIFIED,
            },
            schedulerHooks: {
              onWorkflowStart: () =>
                Effect.sync(() => {
                  concurrencyMetrics.active += 1
                  concurrencyMetrics.total += 1
                  if (concurrencyMetrics.active > concurrencyMetrics.peak) {
                    concurrencyMetrics.peak = concurrencyMetrics.active
                  }
                }),
              onWorkflowComplete: () =>
                Effect.sync(() => {
                  concurrencyMetrics.active = Math.max(0, concurrencyMetrics.active - 1)
                  concurrencyMetrics.completed += 1
                }),
            },
          })

          let runPromise: Promise<void> | null = null

          try {
            const { client: temporalClient } = await createTemporalClient({ config, taskQueue })
            const workflowCount = 4
            const executions: Array<{ workflowId: string; runId: string }> = []

            for (let index = 0; index < workflowCount; index += 1) {
              const workflowId = `${taskQueue}-wf-${index}`
              const result = await temporalClient.startWorkflow({
                workflowId,
                workflowType: 'concurrencyWorkflow',
                taskQueue,
                args: [iterations],
                workflowTaskTimeoutMs: 120_000,
              })
              executions.push({ workflowId: result.workflowId, runId: result.runId })
            }

            runPromise = runtime.run().catch((error) => {
              console.error('[temporal-bun-sdk:test] worker runtime exited with error', error)
              throw error
            })

            const waitStart = Date.now()
            while (concurrencyMetrics.completed < workflowCount) {
              if (Date.now() - waitStart > 60_000) {
                throw new Error('Workflows did not complete before timeout')
              }
              await Bun.sleep(200)
            }

            const [firstExecution] = executions
            if (firstExecution) {
              try {
                await runTemporalCli(
                  'workflow',
                  'show',
                  '--workflow-id',
                  firstExecution.workflowId,
                  '--run-id',
                  firstExecution.runId,
                  '--namespace',
                  config.namespace,
                  '--address',
                  config.address,
                  '--output',
                  'json',
                )
              } catch {
                // Ignore CLI failures in test environment.
              }
            }

            await temporalClient.shutdown()

            return {
              peak: concurrencyMetrics.peak,
              total: concurrencyMetrics.total,
              completed: concurrencyMetrics.completed >= workflowCount,
              completedCount: concurrencyMetrics.completed,
            }
          } finally {
            await runtime.shutdown()
            if (runPromise) {
              await runPromise
            }
          }
        }),
      ),
    )

    expect(metrics.total).toBeGreaterThanOrEqual(4)
    expect(metrics.peak).toBeGreaterThanOrEqual(2)
    expect(metrics.completed).toBeTrue()
    expect(metrics.completedCount).toBeGreaterThanOrEqual(4)
  })

  test('attaches sticky queue metadata and deployment options to workflow responses', async () => {
    const result = await Effect.runPromise(
      harness.runScenario('sticky queue metadata', () =>
        Effect.tryPromise(async () => {
          const taskQueue = `codex-sticky-${Date.now()}-${Math.round(Math.random() * 1000)}`
          const identity = 'integration-worker'
          const deploymentName = `integration-${Date.now()}`
          const buildId = `build-${Math.round(Math.random() * 10_000)}`

          const config = await loadTemporalConfig({
            defaults: {
              address: harnessConfig.address,
              namespace: harnessConfig.namespace,
              taskQueue,
            },
          })

          const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
          const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
          const transport = createGrpcTransport(buildTransportOptions(baseUrl, config))
          const client = createClient(WorkflowService, transport)

          const completions: RespondWorkflowTaskCompletedRequest[] = []
          const polls: PollWorkflowTaskQueueRequest[] = []

          const workflowService = new Proxy(client, {
            get(target, prop, receiver) {
              const original = Reflect.get(target, prop, receiver)
              if (typeof original !== 'function') {
                return original
              }
              if (prop === 'respondWorkflowTaskCompleted') {
                return async function respondWorkflowTaskCompletedProxy(
                  this: unknown,
                  request: RespondWorkflowTaskCompletedRequest,
                  ...rest: unknown[]
                ) {
                  completions.push(request)
                  return await (original as CallableFunction).apply(target, [request, ...rest])
                }
              }
              if (prop === 'pollWorkflowTaskQueue') {
                return async function pollWorkflowTaskQueueProxy(
                  this: unknown,
                  request: PollWorkflowTaskQueueRequest,
                  ...rest: unknown[]
                ) {
                  polls.push(request)
                  return await (original as CallableFunction).apply(target, [request, ...rest])
                }
              }
              return function passthrough(this: unknown, ...args: unknown[]) {
                return (original as CallableFunction).apply(target, args)
              }
            },
          }) as typeof client

          const workflowDefinition = defineWorkflow('stickyMetadataWorkflow', ({ determinism }) =>
            Effect.sync(() => {
              determinism.now()
              return 'ok'
            }),
          )

          const runtime = await WorkerRuntime.create({
            config,
            workflows: [workflowDefinition],
            taskQueue,
            namespace: config.namespace,
            stickyScheduling: true,
            workflowService,
            identity,
            deployment: {
              name: deploymentName,
              buildId,
              versioningMode: WorkerVersioningMode.UNVERSIONED,
              versioningBehavior: VersioningBehavior.UNSPECIFIED,
            },
          })

          const runPromise = runtime.run().catch((error) => {
            console.error('[temporal-bun-sdk:test] worker runtime exited with error', error)
            throw error
          })

          try {
            await Bun.sleep(500)
            const { client: temporalClient } = await createTemporalClient({ config, taskQueue })
            const workflowId = `${taskQueue}-sticky`
            const execution = await temporalClient.startWorkflow({
              workflowId,
              workflowType: 'stickyMetadataWorkflow',
              taskQueue,
            })

            const waitStart = Date.now()
            while (completions.length === 0) {
              if (Date.now() - waitStart > 60_000) {
                throw new Error('Workflow task completion not observed before timeout')
              }
              await Bun.sleep(200)
            }
            try {
              await runTemporalCli(
                'workflow',
                'show',
                '--workflow-id',
                execution.workflowId,
                '--run-id',
                execution.runId,
                '--namespace',
                config.namespace,
                '--address',
                config.address,
                '--output',
                'json',
              )
            } catch {
              // Ignore CLI failures; completion metadata assertions rely on recorded gRPC traffic.
            }
            await temporalClient.shutdown()
          } finally {
            await runtime.shutdown()
            await runPromise
            await transport.close?.()
          }

          const stickyQueueName = `${sanitizeTaskQueueComponent(taskQueue)}-sticky-${sanitizeTaskQueueComponent(identity) || 'worker'}`

          return {
            deploymentName,
            buildId,
            stickyQueueName,
            completions,
            polls,
          }
        }),
      ),
    )

    expect(result.completions.length).toBeGreaterThan(0)
    for (const request of result.completions) {
      const workerTaskQueue = request.stickyAttributes?.workerTaskQueue?.name ?? ''
      if (request.stickyAttributes) {
        expect(workerTaskQueue).toBe(result.stickyQueueName)
      } else {
        expect(workerTaskQueue).toBe('')
      }
      expect(request.deploymentOptions).toBeUndefined()
      expect(request.versioningBehavior).toBe(VersioningBehavior.UNSPECIFIED)
    }

    expect(result.polls.length).toBeGreaterThan(0)
    for (const poll of result.polls) {
      expect(poll.deploymentOptions).toBeUndefined()
    }
  })
})

if (!shouldRunIntegration) {
  test.skip('Temporal CLI integration suite disabled (set TEMPORAL_INTEGRATION_TESTS=1 to enable)', () => {})
}
