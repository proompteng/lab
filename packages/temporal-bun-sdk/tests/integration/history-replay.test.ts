import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { join } from 'node:path'

import { Effect } from 'effect'
import { setTimeout as delay } from 'node:timers/promises'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { makeStickyCache } from '../../src/worker/sticky-cache'
import { ingestWorkflowHistory, diffDeterminismState } from '../../src/workflow/replay'
import type { HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'
import { TemporalCliCommandError, type IntegrationHarness, type WorkflowExecutionHandle } from './harness'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, CLI_CONFIG, type IntegrationTestEnv } from './test-env'
import {
  continueAsNewWorkflow,
  parentWorkflow,
  activityWorkflow,
  timerWorkflow,
} from './workflows'

const replayTimeoutMs = 60_000
const hookTimeoutMs = 60_000

let harness: IntegrationHarness | null = null
let stickyCacheSizeEffect: Effect.Effect<number, never, never> | null = null
let stickyCacheClearEffect: Effect.Effect<void, never, never> | null = null
let runOrSkip: (<A>(name: string, scenario: () => Promise<A>) => Promise<A | undefined>) | null = null
let integrationEnv: IntegrationTestEnv | null = null

const dataConverter = createDefaultDataConverter()

beforeAll(async () => {
  integrationEnv = await acquireIntegrationTestEnv()
  harness = integrationEnv.harness
  stickyCacheSizeEffect = integrationEnv.stickyCacheSizeEffect
  stickyCacheClearEffect = integrationEnv.stickyCacheClearEffect
  runOrSkip = integrationEnv.runOrSkip
}, { timeout: hookTimeoutMs })

afterAll(async () => {
  await releaseIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

const execScenario = async <A>(name: string, scenario: () => Promise<A>): Promise<A | undefined> => {
  if (!runOrSkip) {
    throw new Error('Integration environment not initialised')
  }
  return runOrSkip(name, scenario)
}

describe('Temporal CLI history ingestion', () => {
  test('timer workflow history produces timer determinism snapshot', { timeout: replayTimeoutMs }, async () => {
    await execScenario('timer workflow', async () => {
      const execution = await runTimerWorkflow()
      const history = await fetchHistory(execution)
      const replay = await Effect.runPromise(
        ingestWorkflowHistory({
          info: buildWorkflowInfo(timerWorkflow.name, execution),
          history,
          dataConverter,
        }),
      )
      expect(replay.lastEventId).not.toBeNull()
      expect(replay.determinismState.commandHistory.length).toBeGreaterThan(0)
      expect(replay.determinismState.commandHistory[0]?.intent.kind).toBe('start-timer')
    })
  })

  test('activity workflow history includes activity command intent', { timeout: replayTimeoutMs }, async () => {
    await execScenario('activity workflow', async () => {
      const execution = await runActivityWorkflow('workflow-activity')
      const history = await fetchHistory(execution)
      const replay = await Effect.runPromise(
        ingestWorkflowHistory({
          info: buildWorkflowInfo(activityWorkflow.name, execution),
          history,
          dataConverter,
        }),
      )
      const commandKinds = replay.determinismState.commandHistory.map((entry) => entry.intent.kind)
      expect(commandKinds).toContain('schedule-activity')
    })
  })

  test('child workflow history captures child command', { timeout: replayTimeoutMs }, async () => {
    await execScenario('child workflow', async () => {
      const execution = await runParentWorkflow('workflow-child')
      const history = await fetchHistory(execution)
      const replay = await Effect.runPromise(
        ingestWorkflowHistory({
          info: buildWorkflowInfo(parentWorkflow.name, execution),
          history,
          dataConverter,
        }),
      )
      const childCommand = replay.determinismState.commandHistory.find((entry) => entry.intent.kind === 'start-child-workflow')
      expect(childCommand).toBeDefined()
    })
  })

  test('continue-as-new workflow produces determinism marker chain', { timeout: replayTimeoutMs }, async () => {
    await execScenario('continue-as-new workflow', async () => {
      const execution = await runContinueWorkflow(3)
      const history = await fetchHistory(execution)
      const replay = await Effect.runPromise(
        ingestWorkflowHistory({
          info: buildWorkflowInfo(continueAsNewWorkflow.name, execution),
          history,
          dataConverter,
        }),
      )
      expect(replay.lastEventId).not.toBeNull()
      expect(replay.determinismState.commandHistory.some((entry) => entry.intent.kind === 'continue-as-new')).toBe(true)
    })
  })

  test('diffDeterminismState surfaces command mismatches', { timeout: replayTimeoutMs }, async () => {
    await execScenario('determinism diff', async () => {
      const execution = await runActivityWorkflow('workflow-diff')
      const history = await fetchHistory(execution)
      const replay = await Effect.runPromise(
        ingestWorkflowHistory({
          info: buildWorkflowInfo(activityWorkflow.name, execution),
          history,
          dataConverter,
        }),
      )
      const mutated = {
        ...replay.determinismState,
        commandHistory: replay.determinismState.commandHistory.map((entry, index) =>
          index === 0 && entry.intent.kind === 'schedule-activity'
            ? { intent: { ...entry.intent, activityId: 'mutated-activity' } }
            : entry,
        ),
      }
      const diff = await Effect.runPromise(diffDeterminismState(replay.determinismState, mutated))
      expect(diff.mismatches.length).toBeGreaterThan(0)
    })
  })

  test('temporal-bun replay CLI fetches history via Temporal CLI', { timeout: replayTimeoutMs }, async () => {
    await execScenario('temporal-bun replay cli command', async () => {
      const execution = await runTimerWorkflow('replay-cli')
      const result = await runReplayCliCommand(execution)
      expect(result.exitCode).toBe(0)
      const summaryLine = extractJsonSummary(result.stdout)
      expect(summaryLine).toBeDefined()
      const summary = summaryLine ? JSON.parse(summaryLine) : null
      expect(summary?.workflow.workflowId).toBe(execution.workflowId)
      expect(summary?.determinism.mismatchCount).toBe(0)
      expect(result.stderr.trim()).toBe('')
    })
  })

  test('sticky cache evicts entries beyond capacity', { timeout: replayTimeoutMs }, async () => {
    await execScenario('sticky cache eviction', async () => {
      if (!stickyCacheSizeEffect) {
        throw new Error('Sticky cache not initialised')
      }
      const stickyCache = await Effect.runPromise(makeStickyCache({ maxEntries: 2, ttlMs: 60_000 }))
      await Effect.runPromise(
        stickyCache.upsert({
          key: { namespace: CLI_CONFIG.namespace, workflowId: 'wf-1', runId: 'run-1' },
          determinismState: { commandHistory: [], randomValues: [], timeValues: [], signals: [], queries: [] },
          lastEventId: '1',
          lastAccessed: Date.now(),
        }),
      )
      await Effect.runPromise(
        stickyCache.upsert({
          key: { namespace: CLI_CONFIG.namespace, workflowId: 'wf-2', runId: 'run-2' },
          determinismState: { commandHistory: [], randomValues: [], timeValues: [], signals: [], queries: [] },
          lastEventId: '2',
          lastAccessed: Date.now(),
        }),
      )
      await Effect.runPromise(
        stickyCache.upsert({
          key: { namespace: CLI_CONFIG.namespace, workflowId: 'wf-3', runId: 'run-3' },
          determinismState: { commandHistory: [], randomValues: [], timeValues: [], signals: [], queries: [] },
          lastEventId: '3',
          lastAccessed: Date.now(),
        }),
      )
      const size = await Effect.runPromise(stickyCache.size)
      expect(size).toBeLessThanOrEqual(2)
    })
  })

test('sticky cache remains empty after workflow completion', { timeout: replayTimeoutMs }, async () => {
  await execScenario('sticky cache cleanup', async () => {
    if (!stickyCacheSizeEffect) {
      throw new Error('Sticky cache not initialised')
    }
    if (stickyCacheClearEffect) {
      await Effect.runPromise(stickyCacheClearEffect)
    }
    await runTimerWorkflow()
    const size = await waitForStickyDrain(stickyCacheSizeEffect)
    expect(size).toBe(0)
  })
})
})

const waitForStickyDrain = async (sizeEffect: Effect.Effect<number, never, never>, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  let size = await Effect.runPromise(sizeEffect)
  while (size > 0 && Date.now() < deadline) {
    await delay(100)
    size = await Effect.runPromise(sizeEffect)
  }
  return size
}

const runReplayCliCommand = async (
  execution: WorkflowExecutionHandle,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const cliEntrypoint = join(import.meta.dir, '../../src/bin/temporal-bun.ts')
  const command = [
    'bun',
    cliEntrypoint,
    'replay',
    '--execution',
    `${execution.workflowId}/${execution.runId}`,
    '--workflow-type',
    timerWorkflow.name,
    '--namespace',
    CLI_CONFIG.namespace,
    '--source',
    'cli',
    '--json',
  ] as const

  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      TEMPORAL_ADDRESS: CLI_CONFIG.address,
      TEMPORAL_NAMESPACE: CLI_CONFIG.namespace,
      TEMPORAL_TASK_QUEUE: CLI_CONFIG.taskQueue,
      TEMPORAL_LOG_FORMAT: 'json',
    },
  })

  const exitCode = await child.exited
  const stdout = await readCliStream(child.stdout)
  const stderr = await readCliStream(child.stderr)
  return { exitCode, stdout, stderr }
}

const readCliStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(decoder.decode(value, { stream: true }))
    }
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

const extractJsonSummary = (stdout: string): string | undefined => {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
  return lines[lines.length - 1]
}

const runTimerWorkflow = async (): Promise<WorkflowExecutionHandle> => {
  try {
    const handle = await Effect.runPromise(
      harness!.executeWorkflow({
        workflowType: timerWorkflow.name,
        workflowId: createWorkflowId('timer'),
        taskQueue: CLI_CONFIG.taskQueue,
        args: [{ timeoutMs: 200 }],
      }),
    )
    console.info('[temporal-bun-sdk] timer workflow execution handle', handle)
    return handle
  } catch (error) {
    if (error instanceof TemporalCliCommandError) {
      console.error('[temporal-bun-sdk] temporal CLI stdout', error.stdout)
      console.error('[temporal-bun-sdk] temporal CLI stderr', error.stderr)
    }
    console.error(
      '[temporal-bun-sdk] timer workflow execution failed',
      error instanceof Error ? error.stack ?? error.message : error,
    )
    throw error
  }
}

const runActivityWorkflow = async (seed: string): Promise<WorkflowExecutionHandle> => {
  const workflowId = createWorkflowId(seed)
  return await Effect.runPromise(
    harness!.executeWorkflow({
      workflowType: activityWorkflow.name,
      workflowId,
      taskQueue: CLI_CONFIG.taskQueue,
      args: [{ value: workflowId }],
    }),
  )
}

const runParentWorkflow = async (seed: string): Promise<WorkflowExecutionHandle> => {
  const workflowId = createWorkflowId(seed)
  return await Effect.runPromise(
    harness!.executeWorkflow({
      workflowType: parentWorkflow.name,
      workflowId,
      taskQueue: CLI_CONFIG.taskQueue,
      args: [{ value: workflowId }],
    }),
  )
}

const runContinueWorkflow = async (iterations: number): Promise<WorkflowExecutionHandle> =>
  await Effect.runPromise(
    harness!.executeWorkflow({
      workflowType: continueAsNewWorkflow.name,
      workflowId: createWorkflowId('continue'),
      taskQueue: CLI_CONFIG.taskQueue,
      args: [{ iterations }],
    }),
  )

const fetchHistory = async (handle: WorkflowExecutionHandle): Promise<HistoryEvent[]> =>
  await Effect.runPromise(harness!.fetchWorkflowHistory(handle))

const buildWorkflowInfo = (workflowType: string, handle: WorkflowExecutionHandle) => ({
  namespace: CLI_CONFIG.namespace,
  taskQueue: CLI_CONFIG.taskQueue,
  workflowId: handle.workflowId,
  runId: handle.runId,
  workflowType,
})

const createWorkflowId = (seed?: string): string => {
  const prefix = seed ?? 'cli-integration'
  return `${prefix}-${crypto.randomUUID()}`
}
