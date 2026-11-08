import { nativeChartInference, entryProviderFixture } from './entry-inference.test-support'
import { expect, test } from 'bun:test'
import { Cause, Clock, Effect, Exit, Fiber, Layer, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { canonicalHashV1Result } from '../hash'
import { operationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, JevError } from './client'
import { decodeJevResponse, JevFailure, prepareJevRequest } from './contract'
import { EntryInferenceJournal, prepareClaimedEntry, type EntryHandoff } from './entry-inference'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { makeJevDispatch, JevEvaluationStore, type JevEvaluationRecord } from './evaluation'
import { defaultJevProtocolDocument } from './protocol'
import { JevOutcome, makeJevEvaluationRequest } from './evidence'
import type { StagedDispatchClaim } from './staged-checkpoint'

const at = Date.parse('2026-10-25T07:00:32.000Z')
const fixture = () => {
  const bars = [
    { minuteBeforeWindowEnd: 4, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ]
  return {
    requestId: 'a'.repeat(64),
    observedAt: utcInstantFromEpochMillis(at),
    claimedAt: utcInstantFromEpochMillis(at),
    expiresAt: utcInstantFromEpochMillis(at + 10_000),
    input: {
      schemaVersion: 'bayn.entry-inference-input.v8' as const,
      numericalState: {
        schemaVersion: defaultJevProtocolDocument.inputDefinition,
        webullContext: null,
        entryEconomics: { maximumEntryQuoteDriftBps: 0, maximumEntryLimitSlippageBps: 0 },
        task: { decisionPurpose: 'ENTRY' },
        candidate: { symbol: 'AAPL', bars1m: bars },
        benchmark: { symbol: 'SPY' },
        relativeSignals: {},
        session: { completedBarWindowEndsAt: '2026-10-25T07:00:00.000Z' },
      },
      chartSource: { symbol: 'AAPL', windowEndAt: '2026-10-25T07:00:00.000Z', bars },
      protocol: defaultJevProtocolDocument,
      funding: { bidMicros: '104000000', askMicros: '104020000', capitalMicros: '100000000000', cryptoFeeTier: null },
    },
  }
}

const providers = (
  options: {
    readonly commitDelay?: number
    readonly jevDelay?: number | readonly number[]
    readonly visualFailure?: boolean
    readonly jevFailure?: boolean
    readonly existingHandoff?: boolean
    readonly afterVisual?: () => void
    readonly chartClaimDenied?: boolean
    readonly chartClaimDelay?: number
    readonly chartTerminalFails?: boolean
    readonly chartTerminalDelay?: number
    readonly slowChartFailure?: boolean
    readonly slowChartDelay?: number
    readonly slowChartCommitFails?: boolean
    readonly journalCommitDelay?: number
    readonly cleanupTerminalFails?: boolean
    readonly receiptFailure?: boolean
  } = {},
) => {
  let activeProviders = 0
  let peakProviders = 0
  const durableJevRequests = new Set<string>()
  const records: JevEvaluationRecord[] = []
  let receiptAttempts = 0
  const events: string[] = []
  const checkpointEvents: string[] = []
  const handoffs: EntryHandoff[] = []
  const commits: string[] = []
  const jevBudgets: (number | undefined)[] = []
  const providerStarts: { readonly kind: 'chart' | 'jev'; readonly at: number; readonly budget?: number }[] = []
  const commit = <A, E, R>(name: string, operation: Effect.Effect<A, E, R>) =>
    Effect.sync(() => commits.push(name)).pipe(
      Effect.andThen(operation),
      Effect.tap(() => Effect.sleep(options.journalCommitDelay ?? 0)),
      Effect.tap(() =>
        Effect.sync(() => {
          for (const handoff of handoffs)
            if (handoff.disposition.status === 'READY')
              durableJevRequests.add(Result.getOrThrow(prepareJevRequest(handoff.disposition.jevRequest)).requestHash)
        }),
      ),
    )
  const recordClaim = (_claim: StagedDispatchClaim) =>
    Effect.gen(function* () {
      checkpointEvents.push('claim')
      if (options.chartClaimDelay !== undefined) yield* Effect.sleep(options.chartClaimDelay)
      return {
        dispatchAllowed: options.chartClaimDenied !== true,
      }
    })
  const recordHandoff = (handoff: EntryHandoff) =>
    Effect.gen(function* () {
      events.push('handoff')
      checkpointEvents.push('handoff')
      handoffs.push(handoff)
      const { handoffHash, ...material } = handoff
      expect(handoffHash).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
      if (options.commitDelay !== undefined) yield* Effect.sleep(options.commitDelay)
      return { dispatchAllowed: options.existingHandoff !== true }
    })
  const layer = Layer.mergeAll(
    Layer.succeed(EntryInferenceJournal, {
      recordVisualClaims: (inputs) =>
        commit(
          'claims',
          Effect.forEach(inputs, (claim) =>
            recordClaim(claim).pipe(Effect.map((result) => ({ requestId: claim.requestId, ...result }))),
          ),
        ),
      recordTransitions: (inputs) =>
        commit(
          'transitions',
          Effect.gen(function* () {
            if (
              inputs.some((input) => input.terminal !== null && input.successor.kind !== 'NONE') &&
              options.chartTerminalDelay !== undefined
            )
              yield* Effect.sleep(options.chartTerminalDelay)
            return yield* Effect.forEach(inputs, ({ terminal, successor }) =>
              Effect.gen(function* () {
                const requestId = terminal === null ? successor.handoff.requestId : terminal.requestId
                if (terminal !== null) {
                  checkpointEvents.push('terminal')
                  if (successor.kind === 'NONE' && options.cleanupTerminalFails)
                    return yield* operationalError({
                      component: 'journal',
                      operation: 'test cleanup',
                      message: 'Terminal cleanup unavailable',
                    })
                  if (
                    successor.kind !== 'NONE' &&
                    (options.chartTerminalFails ||
                      (terminal.requestId === 'a'.repeat(64) && options.slowChartCommitFails))
                  )
                    return yield* operationalError({
                      component: 'journal',
                      operation: 'test chart terminal commit',
                      message: 'Unavailable',
                    })
                }
                const result =
                  successor.kind === 'NONE' ? { dispatchAllowed: false } : yield* recordHandoff(successor.handoff)
                return { requestId, ...result }
              }),
            )
          }),
        ),
    }),
    Layer.succeed(
      JevClient,
      entryProviderFixture(
        {
          evaluate: (input, timeoutMs) =>
            Effect.gen(function* () {
              activeProviders++
              peakProviders = Math.max(peakProviders, activeProviders)
              expect(handoffs.length).toBeGreaterThan(0)
              jevBudgets.push(timeoutMs)
              events.push('jev')
              checkpointEvents.push('jev')
              const started = yield* Clock.currentTimeMillis
              providerStarts.push({ kind: 'jev', at: started, budget: timeoutMs })
              const prepared = Result.getOrThrow(prepareJevRequest(input))
              expect(durableJevRequests.has(prepared.requestHash)).toBe(true)
              if (options.jevFailure)
                return yield* new JevError({
                  failure: JevFailure.Transport,
                  message: 'Unavailable',
                  requestHash: prepared.requestHash,
                })
              const delay =
                typeof options.jevDelay === 'number' ? options.jevDelay : options.jevDelay?.[jevBudgets.length - 1]
              if (delay !== undefined) yield* Effect.sleep(delay)
              const response = Result.getOrThrow(
                decodeJevResponse(prepared.request, {
                  model: prepared.request.model,
                  answers: Object.fromEntries(
                    Object.keys(prepared.request.questions).map((name) => [
                      name,
                      { type: 'noul', noul: name.endsWith('_target_obstructed') ? 0.1 : 0.9 },
                    ]),
                  ),
                  usage: { input_tokens: 200, output_tokens: 0 },
                }),
              )
              return {
                requestHash: prepared.requestHash,
                responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
                startedAt: utcInstantFromEpochMillis(started),
                completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                response,
              }
            }).pipe(
              Effect.onExit(() =>
                Effect.sync(() => {
                  activeProviders--
                }),
              ),
            ),
        },
        {
          evaluate: (input, timeoutMs) =>
            Effect.gen(function* () {
              activeProviders++
              peakProviders = Math.max(peakProviders, activeProviders)
              events.push('visual')
              checkpointEvents.push('visual')
              const started = yield* Clock.currentTimeMillis
              const prepared = Result.getOrThrow(prepareJevRequest(input))
              const state = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ source: Schema.Struct({ bars: Schema.Array(Schema.Unknown) }) }),
              )(prepared.request.state).pipe(Effect.orDie)
              const isSlow = state.source.bars.length === 4
              providerStarts.push({ kind: 'chart', at: started, budget: timeoutMs })
              if (options.visualFailure || (isSlow && options.slowChartFailure))
                return yield* new JevError({
                  failure: JevFailure.Status,
                  message: 'Limited',
                  status: 429,
                  requestHash: prepared.requestHash,
                  responseHash: 'b'.repeat(64),
                  rejectedResponse: Redacted.make({
                    model: prepared.request.model,
                    usage: { input_tokens: 100, output_tokens: 0 },
                  }),
                })
              if (isSlow && options.slowChartDelay !== undefined) yield* Effect.sleep(options.slowChartDelay)
              const response = nativeChartInference(
                input,
                utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
              ).response
              options.afterVisual?.()
              return {
                requestHash: prepared.requestHash,
                responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
                startedAt: utcInstantFromEpochMillis(started),
                completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                response,
              }
            }).pipe(
              Effect.onExit(() =>
                Effect.sync(() => {
                  activeProviders--
                }),
              ),
            ),
        },
      ),
    ),
    Layer.succeed(JevEvaluationStore, {
      read: () => Effect.die('Unexpected read'),
      abandon: () => Effect.die('Unexpected abandon'),
      recordAll: (entries) =>
        Effect.gen(function* () {
          receiptAttempts++
          if (options.receiptFailure)
            return yield* operationalError({
              component: 'journal',
              operation: 'test receipt cleanup',
              message: 'Receipt cleanup unavailable',
            })
          records.push(...entries)
          return new Map()
        }),
    }),
  )
  return {
    events,
    checkpointEvents,
    handoffs,
    commits,
    jevBudgets,
    providerStarts,
    records,
    peakProviders: () => peakProviders,
    receiptAttempts: () => receiptAttempts,
    layer,
  }
}

const mixedDispatches = () => {
  const base = fixture()
  const bars = Array.from({ length: 6 }, (_, index) => ({
    minuteBeforeWindowEnd: 6 - index,
    open: 100,
    high: 108,
    low: 97,
    close: 104,
    volume: 100,
  }))
  const direct = {
    ...base,
    requestId: 'd'.repeat(64),
    input: {
      ...base.input,
      chartSource: { ...base.input.chartSource, bars },
      numericalState: { ...base.input.numericalState, candidate: { symbol: 'AAPL', bars1m: bars } },
    },
  }
  return [direct, base].map((claim) => {
    const prepared = Result.getOrThrow(prepareClaimedEntry(claim))
    return makeJevDispatch({
      claimedAt: claim.claimedAt,
      visualClaim: prepared.visualClaim,
      request: {
        schemaVersion: 'bayn.jev-evaluation-request.v3',
        requestId: claim.requestId,
        cycleId: 'a'.repeat(64),
        authorityGenerationHash: 'b'.repeat(64),
        snapshotId: 'c'.repeat(64),
        symbol: 'AAPL',
        observedAt: claim.observedAt,
        expiresAt: claim.expiresAt,
        request: prepared.prepared.input,
        requestHash: prepared.prepared.requestHash,
      },
    })
  })
}

const lateDispatches = () =>
  mixedDispatches().map((dispatch) => {
    const observedAt = utcInstantFromEpochMillis(at + 55_000)
    const claimedAt = utcInstantFromEpochMillis(at + 59_000)
    const expiresAt = utcInstantFromEpochMillis(at + 65_000)
    const request = Result.getOrThrow(
      makeJevEvaluationRequest({
        schemaVersion: dispatch.request.schemaVersion,
        cycleId: dispatch.request.cycleId,
        authorityGenerationHash: dispatch.request.authorityGenerationHash,
        snapshotId: dispatch.request.snapshotId,
        symbol: dispatch.request.symbol,
        observedAt,
        expiresAt,
        requestHash: dispatch.request.requestHash,
        request: dispatch.request.request,
      }),
    )
    const prepared = Result.getOrThrow(
      prepareClaimedEntry({
        requestId: request.requestId,
        input: request.request,
        observedAt,
        expiresAt,
        claimedAt,
      }),
    )
    return makeJevDispatch({ claimedAt, visualClaim: prepared.visualClaim, request })
  })

test('durable ready handoff overlaps unrelated chart work without changing deadlines or input order', async () => {
  const setup = providers({ slowChartDelay: 5000, jevDelay: [5000, 0] })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const dispatches = mixedDispatches()
      const fiber = yield* evaluateClaimedEntryInferences(dispatches).pipe(Effect.forkChild)
      yield* TestClock.adjust(1)
      expect(setup.handoffs.filter((handoff) => handoff.disposition.status === 'READY')).toHaveLength(1)
      expect(setup.jevBudgets).toEqual([10000])
      yield* TestClock.adjust(4999)
      const results = yield* Fiber.join(fiber)
      expect(results.map((result) => result.handoff.requestId)).toEqual(
        dispatches.map((entry) => entry.request.requestId),
      )
      expect(results.map((result) => result.completedAt)).toEqual([
        utcInstantFromEpochMillis(at + 5000),
        utcInstantFromEpochMillis(at + 5000),
      ])
      expect(setup.jevBudgets).toEqual([10000, 5000])
      expect(setup.commits).toEqual(['transitions', 'transitions'])
      expect(setup.peakProviders()).toBeLessThanOrEqual(2)
      expect(setup.records).toHaveLength(0)
      const replay = yield* evaluateClaimedEntryInferences(dispatches).pipe(Effect.result)
      expect(Result.isFailure(replay)).toBe(true)
      expect(setup.jevBudgets).toHaveLength(2)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('bounds an in-flight provider by the enclosing admission deadline', async () => {
  const setup = providers({ slowChartDelay: 5000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at + 59_000)
      const dispatch = lateDispatches()[1]
      if (dispatch === undefined) return yield* Effect.die('late deadline fixture is absent')
      const dispatches = [dispatch]
      const fiber = yield* evaluateClaimedEntryInferences(dispatches, {
        admissionDeadlineAt: at + 60_000,
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(999)
      expect(setup.providerStarts).toHaveLength(1)
      expect(
        setup.providerStarts.every(
          ({ kind, at: started, budget }) => kind === 'chart' && started === at + 59_000 && budget === 1000,
        ),
      ).toBe(true)
      expect(setup.jevBudgets).toHaveLength(0)
      yield* TestClock.adjust(1)
      const completions = yield* Fiber.join(fiber)
      expect(completions).toHaveLength(1)
      expect(completions.every(({ jev }) => jev.status === 'NOT_REQUESTED')).toBe(true)
      expect(completions.every(({ completedAt }) => completedAt === utcInstantFromEpochMillis(at + 60_000))).toBe(true)
      expect(setup.providerStarts.every(({ at: started }) => started < at + 60_000)).toBe(true)
      expect(dispatches.every(({ request }) => request.expiresAt === utcInstantFromEpochMillis(at + 65_000))).toBe(true)
      expect(
        dispatches.every(({ visualClaim }) => visualClaim?.expiresAt === utcInstantFromEpochMillis(at + 65_000)),
      ).toBe(true)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('retains validated paid visual evidence when the provider returns at the admission boundary', async () => {
  const setup = providers({ slowChartDelay: 1000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at + 59_000)
      const dispatch = lateDispatches()[1]
      if (dispatch === undefined) return yield* Effect.die('late boundary fixture is absent')
      const fiber = yield* evaluateClaimedEntryInferences([dispatch], {
        admissionDeadlineAt: at + 60_000,
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(1000)
      const [completion] = yield* Fiber.join(fiber)
      expect(completion?.jev.status).toBe('NOT_REQUESTED')
      const failed = setup.handoffs[0]?.disposition
      if (failed?.status !== 'VISUAL_FAILED') throw new Error('boundary visual failure is absent')
      expect(failed.failure.category).toBe('DEADLINE')
      expect(failed.failure.responseHash).not.toBeNull()
      expect(failed.failure.usage).toEqual({ input_tokens: 100, output_tokens: 0 })
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('does not start a new stage after an admission deadline crossed during commit', async () => {
  const setup = providers({ chartTerminalDelay: 2000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at + 59_000)
      const fiber = yield* evaluateClaimedEntryInferences(lateDispatches(), {
        admissionDeadlineAt: at + 60_000,
      }).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(2000)
      const result = yield* Fiber.join(fiber)
      expect(Result.isFailure(result)).toBe(true)
      expect(setup.providerStarts).toHaveLength(2)
      expect(setup.providerStarts.every(({ kind, at: started }) => kind === 'chart' && started < at + 60_000)).toBe(
        true,
      )
      expect(setup.jevBudgets).toHaveLength(0)
      expect(setup.records).toHaveLength(0)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('bounds dependent Jev dispatches by the same admission deadline', async () => {
  const setup = providers({ jevDelay: 5000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at + 59_000)
      const fiber = yield* evaluateClaimedEntryInferences(lateDispatches(), {
        admissionDeadlineAt: at + 60_000,
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(1000)
      const completions = yield* Fiber.join(fiber)
      expect(completions).toHaveLength(2)
      expect(completions.every(({ jev }) => jev.status === 'FAILED' && jev.failure === JevFailure.Timeout)).toBe(true)
      expect(setup.providerStarts.some(({ kind }) => kind === 'jev')).toBe(true)
      expect(setup.providerStarts.every(({ at: started, budget }) => started < at + 60_000 && budget === 1000)).toBe(
        true,
      )
      expect(setup.jevBudgets).toEqual([1000, 1000])
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('each Jev dispatch waits for its own durable journal commit', async () => {
  const setup = providers({ slowChartDelay: 1000, journalCommitDelay: 2000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const fiber = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.forkChild)
      yield* TestClock.adjust(1999)
      expect(setup.jevBudgets).toHaveLength(0)
      yield* TestClock.adjust(1)
      expect(setup.jevBudgets).toEqual([8000])
      yield* TestClock.adjust(999)
      expect(setup.jevBudgets).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(setup.jevBudgets).toEqual([8000, 7000])
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('second journal failure settles the paid sibling and retains its receipt exactly once', async () => {
  const setup = providers({ slowChartDelay: 1000, slowChartCommitFails: true, jevDelay: 2000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const fiber = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(2000)
      expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      expect(setup.jevBudgets).toEqual([10000])
      expect(setup.records).toHaveLength(1)
      expect(setup.records[0]?.request.requestId).toBe('d'.repeat(64))
      expect(setup.records[0]?.receipt.outcome.status).toBe(JevOutcome.Completed)
      expect(setup.peakProviders()).toBeLessThanOrEqual(2)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('interruption retains the already completed paid sibling once', async () => {
  const setup = providers({ slowChartDelay: 5000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const fiber = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.forkChild)
      yield* TestClock.adjust(1)
      expect(setup.jevBudgets).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(setup.records).toHaveLength(1)
      expect(setup.records[0]?.request.requestId).toBe('d'.repeat(64))
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('first journal failure never starts either dependent provider group', async () => {
  const setup = providers({ chartTerminalFails: true })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const result = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(setup.jevBudgets).toHaveLength(0)
      expect(setup.events.filter((event) => event === 'visual')).toHaveLength(2)
      expect(setup.records).toHaveLength(0)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('slow chart failure does not discard the independent completed Jev evidence', async () => {
  const setup = providers({ slowChartFailure: true })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const results = yield* evaluateClaimedEntryInferences(mixedDispatches())
      expect(results).toHaveLength(2)
      expect(results[0]?.jev.status).toBe('RECEIVED')
      expect(results[1]?.jev.status).toBe('NOT_REQUESTED')
      expect(setup.jevBudgets).toHaveLength(1)
      expect(setup.records).toHaveLength(0)
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

for (const receiptFailure of [false, true]) {
  test(`terminal cleanup failure still attempts independent paid receipts (receipt failure=${receiptFailure})`, async () => {
    const setup = providers({
      slowChartDelay: 1000,
      slowChartCommitFails: true,
      cleanupTerminalFails: true,
      receiptFailure,
      jevDelay: 2000,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(at)
        const fiber = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.exit, Effect.forkChild)
        yield* TestClock.adjust(2000)
        const result = yield* Fiber.join(fiber)
        expect(Exit.isFailure(result)).toBe(true)
        expect(setup.receiptAttempts()).toBe(1)
        expect(setup.jevBudgets).toEqual([10000])
        expect(setup.records).toHaveLength(receiptFailure ? 0 : 1)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain('Unavailable')
          expect(Cause.pretty(result.cause)).toContain('Terminal cleanup unavailable')
          if (receiptFailure) expect(Cause.pretty(result.cause)).toContain('Receipt cleanup unavailable')
        }
      }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
    )
  })
}
