import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../../src/common/payloads'
import type { ActivityResolution } from '../../src/workflow/context'
import type { WorkflowDeterminismState } from '../../src/workflow/determinism'
import { diffDeterminismState } from '../../src/workflow/replay'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { WorkflowRegistry } from '../../src/workflow/registry'

const fuzzSeeds = Math.max(1, Number.parseInt(process.env.TEMPORAL_ASYNC_FUZZ_SEEDS ?? '10000', 10))
const fuzzOperationCount = Math.max(4, Number.parseInt(process.env.TEMPORAL_ASYNC_FUZZ_OPERATIONS ?? '64', 10))
const fuzzTimeoutMs = Math.max(
  60_000,
  Number.parseInt(process.env.TEMPORAL_ASYNC_FUZZ_TIMEOUT_MS ?? '', 10) || fuzzSeeds * 4,
)
const packageRoot = join(import.meta.dir, '../..')
const artifactPath = join(packageRoot, '.artifacts', 'async-fuzz', 'report.json')
const operationNames = [
  'promise-microtask',
  'date-now',
  'math-random',
  'activity',
  'timer',
  'side-effect',
  'version',
  'patch',
  'local-activity',
  'metadata',
] as const
type FuzzOperationName = (typeof operationNames)[number]

const operationNameSet = new Set<string>(operationNames)

const makeRng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const buildActivityResults = (): Map<string, ActivityResolution> => {
  const results = new Map<string, ActivityResolution>()
  for (let index = 0; index < 128; index += 1) {
    results.set(`activity-${index}`, { status: 'completed', value: `activity-result-${index}` })
  }
  return results
}

const timerResults = new Set(Array.from({ length: 128 }, (_, index) => `timer-${index}`))

const registry = new WorkflowRegistry()
const executor = new WorkflowExecutor({
  registry,
  dataConverter: createDefaultDataConverter(),
  workflowGuards: 'strict',
})

registry.register(
  defineWorkflow('asyncFuzzWorkflow', Schema.Struct({ seed: Schema.Number, operations: Schema.Number }), (ctx) =>
    Effect.gen(function* () {
      const rng = makeRng(ctx.input.seed)
      const results: unknown[] = []
      for (let index = 0; index < ctx.input.operations; index += 1) {
        const operationName = operationNames[Math.floor(rng() * operationNames.length)]
        if (operationName === 'promise-microtask') {
          yield* Effect.promise(() => Promise.resolve())
          results.push([operationName, index])
        } else if (operationName === 'date-now') {
          results.push([operationName, Date.now()])
        } else if (operationName === 'math-random') {
          results.push([operationName, Math.random()])
        } else if (operationName === 'activity') {
          const value = yield* ctx.activities.schedule('fuzzActivity', [ctx.input.seed, index])
          results.push([operationName, value])
        } else if (operationName === 'timer') {
          const timer = yield* ctx.timers.start({ timeoutMs: 50 + index })
          results.push([operationName, timer.timerId])
        } else if (operationName === 'side-effect') {
          results.push([
            operationName,
            ctx.determinism.sideEffect({
              identifier: `seed-${ctx.input.seed}-${index}`,
              compute: () => ({ seed: ctx.input.seed, index, value: ctx.input.seed * 31 + index }),
            }),
          ])
        } else if (operationName === 'version') {
          results.push([
            operationName,
            ctx.determinism.getVersion({
              changeId: `change-${index % 3}`,
              minSupported: 1,
              maxSupported: 2,
            }),
          ])
        } else if (operationName === 'patch') {
          results.push([operationName, ctx.determinism.patched(`patch-${index % 4}`)])
        } else if (operationName === 'local-activity') {
          results.push([
            operationName,
            ctx.determinism.localActivity('fuzzLocalActivity', [ctx.input.seed, index], {
              handler: (seed, step) => `local-${seed}-${step}`,
            }),
          ])
        } else {
          ctx.upsertMemo({ [`memo-${index}`]: ctx.input.seed })
          ctx.upsertSearchAttributes({ [`SearchKeywordField-${index}`]: `seed-${ctx.input.seed}` })
          results.push([operationName, index])
        }
      }
      return results
    }),
  ),
)

const executeSeed = async (seed: number, previousState?: WorkflowDeterminismState) =>
  await executor.execute({
    workflowType: 'asyncFuzzWorkflow',
    workflowId: `async-fuzz-${seed}`,
    runId: `async-fuzz-run-${seed}`,
    namespace: 'default',
    taskQueue: 'async-fuzz-task-queue',
    arguments: { seed, operations: fuzzOperationCount },
    determinismState: previousState,
    activityResults: buildActivityResults(),
    timerResults,
  })

const mutateState = (state: WorkflowDeterminismState): WorkflowDeterminismState => {
  if (state.commandHistory[0]?.intent) {
    return {
      ...state,
      commandHistory: [
        {
          ...state.commandHistory[0],
          intent: {
            ...state.commandHistory[0].intent,
            sequence: state.commandHistory[0].intent.sequence + 999,
          },
        },
        ...state.commandHistory.slice(1),
      ],
    }
  }
  if (state.randomValues.length > 0) {
    return { ...state, randomValues: [state.randomValues[0] + 1, ...state.randomValues.slice(1)] }
  }
  if (state.timeValues.length > 0) {
    return { ...state, timeValues: [state.timeValues[0] + 1, ...state.timeValues.slice(1)] }
  }
  return {
    ...state,
    queries: [
      {
        queryName: 'synthetic',
        handlerName: 'synthetic',
        requestHash: 'mutated',
      },
    ],
  }
}

const recordOperationCoverage = (
  result: unknown,
  operationCoverage: Record<FuzzOperationName, number>,
): number => {
  expect(Array.isArray(result)).toBe(true)
  const entries = result as unknown[]
  expect(entries).toHaveLength(fuzzOperationCount)

  for (const entry of entries) {
    expect(Array.isArray(entry)).toBe(true)
    const [operationName] = entry as [unknown, ...unknown[]]
    expect(typeof operationName).toBe('string')
    expect(operationNameSet.has(operationName)).toBe(true)
    operationCoverage[operationName as FuzzOperationName] += 1
  }

  return entries.length
}

test('seeded async workflow interleavings replay deterministically', { timeout: fuzzTimeoutMs }, async () => {
  const startedAt = Date.now()
  let mismatchChecks = 0
  let executedOperations = 0
  const operationCoverage = Object.fromEntries(
    operationNames.map((operationName) => [operationName, 0]),
  ) as Record<FuzzOperationName, number>
  for (let seed = 1; seed <= fuzzSeeds; seed += 1) {
    const first = await executeSeed(seed)
    executedOperations += recordOperationCoverage(first.result, operationCoverage)
    const replayed = await executeSeed(seed, first.determinismState)

    expect(replayed.result).toEqual(first.result)

    const replayDiff = await Effect.runPromise(diffDeterminismState(first.determinismState, replayed.determinismState))
    expect(replayDiff.mismatches).toHaveLength(0)

    const mutated = mutateState(first.determinismState)
    const mutationDiff = await Effect.runPromise(diffDeterminismState(first.determinismState, mutated))
    expect(mutationDiff.mismatches.length).toBeGreaterThan(0)
    mismatchChecks += 1
  }

  expect(mismatchChecks).toBe(fuzzSeeds)
  expect(executedOperations).toBe(fuzzSeeds * fuzzOperationCount)
  for (const operationName of operationNames) {
    expect(operationCoverage[operationName]).toBeGreaterThan(0)
  }
  await mkdir(join(packageRoot, '.artifacts', 'async-fuzz'), { recursive: true })
  await writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        passed: true,
        seedCount: fuzzSeeds,
        operationCount: fuzzOperationCount,
        operationCoverage,
        coverageSource: 'workflow-result',
        executedOperations,
        mismatchChecks,
        oracle: 'first execution must replay byte-for-byte, and a mutated determinism state must produce mismatches',
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
})
