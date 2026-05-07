#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { toJson } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { createTemporalClient, type TemporalClient } from '../src/client'
import type { WorkflowHandle } from '../src/client/types'
import { createDefaultDataConverter } from '../src/common/payloads'
import { loadTemporalConfig } from '../src/config'
import { IndexedValueType } from '../src/proto/temporal/api/enums/v1/common_pb'
import { EventType } from '../src/proto/temporal/api/enums/v1/event_type_pb'
import { HistoryEventSchema, type HistoryEvent } from '../src/proto/temporal/api/history/v1/message_pb'
import type { WorkflowInfo } from '../src/workflow/context'
import { ingestWorkflowHistory } from '../src/workflow/replay'
import type { WorkflowCommandKind } from '../src/workflow/commands'
import {
  activityWorkflow,
  continueAsNewWorkflow,
  heartbeatWorkflow,
  metadataWorkflow,
  parentWorkflow,
  queryOnlyWorkflow,
  retryProbeWorkflow,
  signalQueryWorkflow,
  timerWorkflow,
  timerCancellationWorkflow,
  updateWorkflow,
  workflowTaskFailureWorkflow,
} from '../tests/integration/workflows'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv } from '../tests/integration/test-env'
import { runHarnessEffect, type WorkflowExecutionHandle } from '../tests/integration/harness'
import type { IntegrationTestEnv } from '../tests/integration/test-env'

type ExistingManifest = {
  readonly schemaVersion: 1
  readonly fixtures: readonly ManifestEntry[]
}

type ManifestEntry = {
  readonly name: string
  readonly path: string
  readonly temporalServerVersion?: string
  readonly sdkVersion?: string
  readonly bunVersion?: string
  readonly workflowType: string
  readonly featureTags: readonly string[]
  readonly commandKinds?: readonly WorkflowCommandKind[]
  readonly externalOperationKinds?: readonly ExternalOperationKind[]
  readonly historyEventTypes?: readonly string[]
  readonly historyEventCount: number
  readonly expectedCommandCount: number
  readonly allowEmptyCommandKinds?: boolean
  readonly payloadCodecProfile?: string
  readonly capturedAt?: string
  readonly source?: string
}

type ExternalOperationKind = 'cancel' | 'operator' | 'query' | 'signal' | 'terminate' | 'update'

type CaptureScenario = {
  readonly name: string
  readonly workflowType: string
  readonly args: readonly unknown[]
  readonly featureTags: readonly string[]
  readonly lifecycle?: CaptureLifecycle
  readonly externalOperationKinds?: readonly ExternalOperationKind[]
  readonly allowEmptyCommandKinds?: boolean
}

type CaptureLifecycle =
  | 'execute'
  | 'external-cancellation'
  | 'metadata'
  | 'signal-query'
  | 'timer-cancellation'
  | 'update-rejection'
  | 'update-success'
  | 'workflow-task-failure'

type CapturedHistory = {
  readonly execution: WorkflowExecutionHandle
  readonly history: readonly HistoryEvent[]
  readonly externalOperationKinds?: readonly ExternalOperationKind[]
}

const packageRoot = join(import.meta.dir, '..')
const fixturesDir = join(packageRoot, 'tests', 'replay', 'fixtures')
const manifestPath = join(packageRoot, 'tests', 'replay', 'corpus', 'manifest.json')
const capturePrefix = 'captured-'
const dataConverter = createDefaultDataConverter()
const captureTimeoutMs = 45_000

const scenarios: readonly CaptureScenario[] = [
  {
    name: 'captured-timer-010ms',
    workflowType: timerWorkflow.name,
    args: [{ timeoutMs: 10 }],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-timer-025ms',
    workflowType: timerWorkflow.name,
    args: [{ timeoutMs: 25 }],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-timer-050ms',
    workflowType: timerWorkflow.name,
    args: [{ timeoutMs: 50 }],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-timer-100ms',
    workflowType: timerWorkflow.name,
    args: [{ timeoutMs: 100 }],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-timer-200ms',
    workflowType: timerWorkflow.name,
    args: [{ timeoutMs: 200 }],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-timer-default',
    workflowType: timerWorkflow.name,
    args: [{}],
    featureTags: ['timer', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-alpha',
    workflowType: activityWorkflow.name,
    args: [{ value: 'alpha' }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-json',
    workflowType: activityWorkflow.name,
    args: [{ value: JSON.stringify({ nested: true, index: 1 }) }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-unicode',
    workflowType: activityWorkflow.name,
    args: [{ value: 'temporal-bun-sdk' }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-long',
    workflowType: activityWorkflow.name,
    args: [{ value: 'x'.repeat(512) }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-empty',
    workflowType: activityWorkflow.name,
    args: [{ value: '' }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-activity-punctuation',
    workflowType: activityWorkflow.name,
    args: [{ value: 'activity:retry? no, plain completion.' }],
    featureTags: ['activity', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-child-alpha',
    workflowType: parentWorkflow.name,
    args: [{ value: 'alpha-child' }],
    featureTags: ['child-workflow', 'determinism', 'real-history'],
  },
  {
    name: 'captured-child-beta',
    workflowType: parentWorkflow.name,
    args: [{ value: 'beta-child' }],
    featureTags: ['child-workflow', 'determinism', 'real-history'],
  },
  {
    name: 'captured-child-json',
    workflowType: parentWorkflow.name,
    args: [{ value: JSON.stringify({ child: true }) }],
    featureTags: ['child-workflow', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-child-long',
    workflowType: parentWorkflow.name,
    args: [{ value: 'child'.repeat(64) }],
    featureTags: ['child-workflow', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-continue-two',
    workflowType: continueAsNewWorkflow.name,
    args: [{ iterations: 2 }],
    featureTags: ['continue-as-new', 'determinism', 'real-history'],
  },
  {
    name: 'captured-continue-three',
    workflowType: continueAsNewWorkflow.name,
    args: [{ iterations: 3 }],
    featureTags: ['continue-as-new', 'determinism', 'real-history'],
  },
  {
    name: 'captured-continue-counter',
    workflowType: continueAsNewWorkflow.name,
    args: [{ iterations: 2, counter: 7 }],
    featureTags: ['continue-as-new', 'payload-codec', 'determinism', 'real-history'],
  },
  {
    name: 'captured-continue-four',
    workflowType: continueAsNewWorkflow.name,
    args: [{ iterations: 4 }],
    featureTags: ['continue-as-new', 'determinism', 'real-history'],
  },
  {
    name: 'captured-heartbeat-short',
    workflowType: heartbeatWorkflow.name,
    args: [{ durationMs: 300, heartbeatTimeoutMs: 1_000 }],
    featureTags: ['activity', 'heartbeat', 'determinism', 'real-history'],
  },
  {
    name: 'captured-heartbeat-medium',
    workflowType: heartbeatWorkflow.name,
    args: [{ durationMs: 550, heartbeatTimeoutMs: 1_000 }],
    featureTags: ['activity', 'heartbeat', 'determinism', 'real-history'],
  },
  {
    name: 'captured-retry-once',
    workflowType: retryProbeWorkflow.name,
    args: [{ failUntil: 1, permanentOn: 99, maxAttempts: 3 }],
    featureTags: ['activity', 'retry', 'failure', 'determinism', 'real-history'],
  },
  {
    name: 'captured-retry-twice',
    workflowType: retryProbeWorkflow.name,
    args: [{ failUntil: 2, permanentOn: 99, maxAttempts: 4 }],
    featureTags: ['activity', 'retry', 'failure', 'determinism', 'real-history'],
  },
  {
    name: 'captured-retry-no-failure',
    workflowType: retryProbeWorkflow.name,
    args: [{ failUntil: 0, permanentOn: 99, maxAttempts: 2 }],
    featureTags: ['activity', 'retry', 'determinism', 'real-history'],
  },
  {
    name: 'captured-metadata-search-side-effect-version',
    workflowType: metadataWorkflow.name,
    args: [{ value: 'metadata-alpha' }],
    featureTags: ['determinism', 'payload-codec', 'real-history', 'search-attributes', 'side-effect', 'versioning'],
    lifecycle: 'metadata',
    externalOperationKinds: ['operator'],
  },
  {
    name: 'captured-timer-cancellation',
    workflowType: timerCancellationWorkflow.name,
    args: [{ timeoutMs: 30_000 }],
    featureTags: ['cancellation', 'determinism', 'real-history', 'timer'],
    lifecycle: 'timer-cancellation',
  },
  {
    name: 'captured-signal-query',
    workflowType: signalQueryWorkflow.name,
    args: [],
    featureTags: ['determinism', 'query', 'real-history', 'signal'],
    lifecycle: 'signal-query',
    externalOperationKinds: ['query', 'signal'],
  },
  {
    name: 'captured-update-success',
    workflowType: updateWorkflow.name,
    args: [{ cycles: 6, holdMs: 2_000, initialMessage: 'booting' }],
    featureTags: ['determinism', 'real-history', 'update'],
    lifecycle: 'update-success',
    externalOperationKinds: ['terminate', 'update'],
  },
  {
    name: 'captured-update-rejection',
    workflowType: updateWorkflow.name,
    args: [{ cycles: 6, holdMs: 2_000, initialMessage: 'booting' }],
    featureTags: ['determinism', 'real-history', 'update'],
    lifecycle: 'update-rejection',
    externalOperationKinds: ['terminate', 'update'],
  },
  {
    name: 'captured-external-cancellation',
    workflowType: queryOnlyWorkflow.name,
    args: [],
    featureTags: ['cancellation', 'determinism', 'query', 'real-history'],
    lifecycle: 'external-cancellation',
    externalOperationKinds: ['cancel', 'query', 'terminate'],
  },
  {
    name: 'captured-workflow-task-failure',
    workflowType: workflowTaskFailureWorkflow.name,
    args: [{ value: 'missing-search-attribute' }],
    featureTags: ['failure', 'real-history', 'search-attributes', 'workflow-task-failure'],
    lifecycle: 'workflow-task-failure',
    externalOperationKinds: ['terminate'],
    allowEmptyCommandKinds: true,
  },
]

const main = async () => {
  const capturedAt = new Date().toISOString()
  const [packageJson, temporalCliVersion] = await Promise.all([readPackageJson(), readTemporalCliVersion()])
  const env = await acquireIntegrationTestEnv()

  if (!env.harness || env.isCliUnavailable()) {
    await releaseIntegrationTestEnv()
    throw new Error('Temporal CLI dev server is unavailable; cannot capture replay corpus histories')
  }

  try {
    await mkdir(fixturesDir, { recursive: true })
    await removePreviouslyCapturedFixtures()
    const client = await createCaptureClient(env)

    try {
      const capturedEntries: ManifestEntry[] = []
      for (const scenario of scenarios) {
        const fixture = await env.runOrSkip(`capture replay fixture ${scenario.name}`, async () =>
          captureFixture({
            capturedAt,
            client,
            env,
            packageVersion: packageJson.version,
            scenario,
            temporalCliVersion,
          }),
        )

        if (!fixture) {
          throw new Error(`Replay fixture capture skipped unexpectedly: ${scenario.name}`)
        }
        capturedEntries.push(fixture)
        console.log(
          `[temporal-bun-sdk] captured ${fixture.name}: events=${fixture.historyEventCount} commands=${fixture.expectedCommandCount}`,
        )
      }

      await writeManifest(capturedEntries)
      console.log(
        `[temporal-bun-sdk] replay corpus manifest updated: ${relative(packageRoot, manifestPath)} (${capturedEntries.length} captured fixtures)`,
      )
    } finally {
      await client.shutdown()
    }
  } finally {
    await releaseIntegrationTestEnv()
  }
}

const captureFixture = async ({
  capturedAt,
  client,
  env,
  packageVersion,
  scenario,
  temporalCliVersion,
}: {
  readonly capturedAt: string
  readonly client: TemporalClient
  readonly env: IntegrationTestEnv
  readonly packageVersion: string
  readonly scenario: CaptureScenario
  readonly temporalCliVersion: string
}): Promise<ManifestEntry> => {
  const captured = await captureScenario(env, client, scenario)
  const info: WorkflowInfo & { temporalVersion?: string } = {
    namespace: env.cliConfig.namespace,
    taskQueue: env.cliConfig.taskQueue,
    workflowId: captured.execution.workflowId,
    runId: captured.execution.runId,
    workflowType: scenario.workflowType,
    temporalVersion: temporalCliVersion,
  }
  const history = captured.history
  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history,
      dataConverter,
    }),
  )

  const commandKinds = Array.from(
    new Set(replay.determinismState.commandHistory.map((entry) => entry.intent.kind)),
  ).sort()
  const fileName = `${scenario.name}.json`
  const fixturePath = join(fixturesDir, fileName)
  await writeFixture(fixturePath, {
    name: scenario.name,
    info,
    history,
    expectedDeterminismState: replay.determinismState,
  })

  return {
    name: scenario.name,
    path: `../fixtures/${fileName}`,
    temporalServerVersion: temporalCliVersion,
    sdkVersion: packageVersion,
    bunVersion: Bun.version,
    workflowType: scenario.workflowType,
    featureTags: scenario.featureTags,
    commandKinds,
    externalOperationKinds: mergeExternalOperationKinds(
      scenario.externalOperationKinds ?? [],
      captured.externalOperationKinds ?? [],
    ),
    historyEventTypes: historyEventTypes(history),
    historyEventCount: history.length,
    expectedCommandCount: replay.determinismState.commandHistory.length,
    allowEmptyCommandKinds: scenario.allowEmptyCommandKinds,
    payloadCodecProfile: 'json',
    capturedAt,
    source: 'Temporal CLI dev-server capture via scripts/capture-replay-corpus.ts',
  } satisfies ManifestEntry
}

const captureScenario = async (
  env: IntegrationTestEnv,
  client: TemporalClient,
  scenario: CaptureScenario,
): Promise<CapturedHistory> => {
  const workflowId = `replay-${scenario.name}-${randomUUID()}`
  const lifecycle = scenario.lifecycle ?? 'execute'

  switch (lifecycle) {
    case 'execute':
      return executeAndFetchHistory(env, scenario, workflowId)
    case 'metadata':
      await ensureSearchAttribute(client)
      return executeAndFetchHistory(env, scenario, workflowId)
    case 'timer-cancellation':
      return executeAndFetchHistory(env, scenario, workflowId)
    case 'signal-query':
      return captureSignalQuery(env, client, scenario, workflowId)
    case 'update-success':
      return captureWorkflowUpdate(env, client, scenario, workflowId, 'success')
    case 'update-rejection':
      return captureWorkflowUpdate(env, client, scenario, workflowId, 'rejection')
    case 'external-cancellation':
      return captureExternalCancellation(env, client, scenario, workflowId)
    case 'workflow-task-failure':
      return captureWorkflowTaskFailure(env, client, scenario, workflowId)
  }
}

const executeAndFetchHistory = async (
  env: IntegrationTestEnv,
  scenario: CaptureScenario,
  workflowId: string,
): Promise<CapturedHistory> => {
  const execution = await runHarnessEffect(
    env.harness!.executeWorkflow({
      workflowType: scenario.workflowType,
      workflowId,
      taskQueue: env.cliConfig.taskQueue,
      args: scenario.args,
    }),
  )
  return {
    execution,
    history: await runHarnessEffect(env.harness!.fetchWorkflowHistory(execution)),
  }
}

const startWorkflow = async (
  env: IntegrationTestEnv,
  scenario: CaptureScenario,
  workflowId: string,
): Promise<WorkflowExecutionHandle> =>
  await runHarnessEffect(
    env.harness!.executeWorkflow({
      workflowType: scenario.workflowType,
      workflowId,
      taskQueue: env.cliConfig.taskQueue,
      args: scenario.args,
      startOnly: true,
    }),
  )

const captureSignalQuery = async (
  env: IntegrationTestEnv,
  client: TemporalClient,
  scenario: CaptureScenario,
  workflowId: string,
): Promise<CapturedHistory> => {
  const execution = await startWorkflow(env, scenario, workflowId)
  const handle = toWorkflowHandle(env, execution)
  await queryWithRetry(client, handle, 'state', {})
  await client.workflow.signal(handle, 'unblock', 'integration-ready')
  await queryWithRetry(client, handle, 'state', {})
  await client.workflow.signal(handle, 'finish', {})
  const history = await waitForHistoryEvent(
    env,
    execution,
    (event) => event.eventType === EventType.WORKFLOW_EXECUTION_COMPLETED,
  )
  return { execution, externalOperationKinds: ['query', 'signal'], history }
}

const captureWorkflowUpdate = async (
  env: IntegrationTestEnv,
  client: TemporalClient,
  scenario: CaptureScenario,
  workflowId: string,
  mode: 'rejection' | 'success',
): Promise<CapturedHistory> => {
  const execution = await startWorkflow(env, scenario, workflowId)
  const handle = toWorkflowHandle(env, execution)
  try {
    if (mode === 'success') {
      await client.workflow.update(handle, {
        args: [{ value: 'captured-update' }],
        updateName: 'integrationUpdate.setMessage',
        waitForStage: 'completed',
      })
    } else {
      await client.workflow.update(handle, {
        args: [{ value: 'no' }],
        updateName: 'integrationUpdate.guardMessage',
        waitForStage: 'completed',
      })
    }
  } finally {
    await terminateWorkflow(client, handle, 'replay-corpus-update-cleanup')
  }
  const history = await waitForHistoryEvent(
    env,
    execution,
    (event) => event.eventType === EventType.WORKFLOW_EXECUTION_TERMINATED,
  )
  return { execution, externalOperationKinds: ['terminate', 'update'], history }
}

const captureExternalCancellation = async (
  env: IntegrationTestEnv,
  client: TemporalClient,
  scenario: CaptureScenario,
  workflowId: string,
): Promise<CapturedHistory> => {
  const execution = await startWorkflow(env, scenario, workflowId)
  const handle = toWorkflowHandle(env, execution)
  await queryWithRetry(client, handle, 'status', {})
  await client.workflow.cancel(handle)
  await waitForHistoryEvent(
    env,
    execution,
    (event) => event.eventType === EventType.WORKFLOW_EXECUTION_CANCEL_REQUESTED,
  )
  await terminateWorkflow(client, handle, 'replay-corpus-cancel-cleanup')
  const history = await waitForHistoryEvent(
    env,
    execution,
    (event) => event.eventType === EventType.WORKFLOW_EXECUTION_TERMINATED,
  )
  return { execution, externalOperationKinds: ['cancel', 'query', 'terminate'], history }
}

const captureWorkflowTaskFailure = async (
  env: IntegrationTestEnv,
  client: TemporalClient,
  scenario: CaptureScenario,
  workflowId: string,
): Promise<CapturedHistory> => {
  const execution = await startWorkflow(env, scenario, workflowId)
  await waitForHistoryEvent(env, execution, (event) => event.eventType === EventType.WORKFLOW_TASK_FAILED)
  await terminateWorkflow(client, toWorkflowHandle(env, execution), 'replay-corpus-workflow-task-failure-cleanup')
  const history = await waitForHistoryEvent(
    env,
    execution,
    (event) => event.eventType === EventType.WORKFLOW_EXECUTION_TERMINATED,
  )
  return { execution, externalOperationKinds: ['terminate'], history }
}

const createCaptureClient = async (env: IntegrationTestEnv): Promise<TemporalClient> => {
  const config = await loadTemporalConfig({
    defaults: {
      address: env.cliConfig.address,
      namespace: env.cliConfig.namespace,
      taskQueue: env.cliConfig.taskQueue,
    },
  })
  const { client } = await createTemporalClient({ config, taskQueue: env.cliConfig.taskQueue })
  return client
}

const ensureSearchAttribute = async (client: TemporalClient): Promise<void> => {
  try {
    await client.operator.addSearchAttributes({
      searchAttributes: {
        CustomKeywordField: IndexedValueType.KEYWORD,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already|exists|mapping/i.test(message)) {
      throw error
    }
  }
}

const queryWithRetry = async (
  client: TemporalClient,
  handle: WorkflowHandle,
  queryName: string,
  input: unknown,
): Promise<unknown> => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await client.workflow.query(handle, queryName, input)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/please retry|not found|no query handler|query/i.test(message) && attempt > 2) {
        throw error
      }
      await Bun.sleep(250 * attempt)
    }
  }
  throw lastError
}

const terminateWorkflow = async (client: TemporalClient, handle: WorkflowHandle, reason: string): Promise<void> => {
  try {
    await client.workflow.terminate(handle, { reason })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 'not_found' || /completed|not[_\s-]?found|terminated/i.test(message)) {
      return
    }
    throw error
  }
}

const waitForHistoryEvent = async (
  env: IntegrationTestEnv,
  execution: WorkflowExecutionHandle,
  predicate: (event: HistoryEvent) => boolean,
): Promise<HistoryEvent[]> => {
  const deadline = Date.now() + captureTimeoutMs
  let latestHistory: HistoryEvent[] = []
  while (Date.now() < deadline) {
    latestHistory = await runHarnessEffect(env.harness!.fetchWorkflowHistory(execution))
    if (latestHistory.some(predicate)) {
      return latestHistory
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for history event in workflow ${execution.workflowId}`)
}

const toWorkflowHandle = (env: IntegrationTestEnv, execution: WorkflowExecutionHandle): WorkflowHandle => ({
  namespace: env.cliConfig.namespace,
  runId: execution.runId,
  workflowId: execution.workflowId,
})

const historyEventTypes = (history: readonly HistoryEvent[]): readonly string[] =>
  Array.from(new Set(history.map((event) => historyEventTypeName(event.eventType)))).sort((left, right) =>
    left.localeCompare(right),
  )

const historyEventTypeName = (eventType: EventType): string => {
  const name = EventType[eventType]
  return name ? `EVENT_TYPE_${name}` : `EVENT_TYPE_UNKNOWN_${eventType}`
}

const mergeExternalOperationKinds = (
  left: readonly ExternalOperationKind[],
  right: readonly ExternalOperationKind[],
): readonly ExternalOperationKind[] => Array.from(new Set([...left, ...right])).sort((a, b) => a.localeCompare(b))

const readPackageJson = async (): Promise<{ readonly version: string }> =>
  JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { readonly version: string }

const readTemporalCliVersion = async (): Promise<string> => {
  const child = Bun.spawn(['temporal', '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readStream(child.stdout),
    readStream(child.stderr),
  ])
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`
    throw new Error(`Unable to read Temporal CLI version: ${detail}`)
  }
  return stdout.trim()
}

const removePreviouslyCapturedFixtures = async () => {
  const files = await readdir(fixturesDir)
  await Promise.all(
    files
      .filter((file) => file.startsWith(capturePrefix) && file.endsWith('.json'))
      .map((file) => rm(join(fixturesDir, file), { force: true })),
  )
}

const writeFixture = async (
  path: string,
  fixture: {
    readonly name: string
    readonly info: WorkflowInfo & { temporalVersion?: string }
    readonly history: readonly HistoryEvent[]
    readonly expectedDeterminismState: unknown
  },
) => {
  await mkdir(dirname(path), { recursive: true })
  const serialized = {
    name: fixture.name,
    info: fixture.info,
    history: fixture.history.map((event) => toJson(HistoryEventSchema, event)),
    expectedDeterminismState: fixture.expectedDeterminismState,
  }
  await writeFile(path, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
}

const writeManifest = async (capturedEntries: readonly ManifestEntry[]) => {
  const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as ExistingManifest
  const staticFixtures = existing.fixtures.filter((entry) => !entry.name.startsWith(capturePrefix))
  const nextManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixtures: [...staticFixtures, ...capturedEntries],
  }
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
}

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

await main()
