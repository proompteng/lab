import { expect, test } from 'bun:test'
import { Cause, Clock, Effect, Exit, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { canonicalHashV1Result } from '../hash'
import { operationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, JevError } from './client'
import { decodeJevResponse, JevFailure, prepareJevRequest } from './contract'
import { DecisionsClient, DecisionsError, decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'
import { EntryInferenceJournal, prepareClaimedEntry, type EntryHandoff } from './entry-inference'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { makeJevDispatch, JevEvaluationStore, type JevEvaluationRecord } from './evaluation'
import { defaultJevProtocolDocument } from './protocol'
import { JevOutcome } from './evidence'
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
        schemaVersion: 'bayn.jev-entry-state.v23',
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
    readonly visualDelay?: number
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
    readonly baseFailure?: boolean
    readonly baseDelay?: number
    readonly baseClaimDenied?: boolean
    readonly baseTerminalFails?: boolean
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
  const recordClaim = (claim: StagedDispatchClaim) =>
    Effect.gen(function* () {
      checkpointEvents.push('claim')
      if (options.chartClaimDelay !== undefined) yield* Effect.sleep(options.chartClaimDelay)
      return {
        dispatchAllowed:
          options.chartClaimDenied !== true && !(claim.stage === 'BASE_START' && options.baseClaimDenied),
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
    Layer.succeed(DecisionsClient, {
      evaluate: (input) =>
        Effect.gen(function* () {
          activeProviders++
          peakProviders = Math.max(peakProviders, activeProviders)
          events.push('visual')
          checkpointEvents.push('visual')
          const started = yield* Clock.currentTimeMillis
          const prepared = Result.getOrThrow(prepareDecisionsRequest(input))
          const isBase = prepared.request.questions.length === 1
          if (options.visualFailure || (isBase && options.baseFailure))
            return yield* new DecisionsError({
              category: 'STATUS',
              message: 'Limited',
              status: 429,
              requestHash: prepared.requestHash,
              responseHash: 'b'.repeat(64),
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 0,
                total_tokens: 100,
              },
            })
          if (options.visualDelay !== undefined && prepared.request.questions.length > 1)
            yield* Effect.sleep(options.visualDelay)
          if (isBase && options.baseDelay !== undefined) yield* Effect.sleep(options.baseDelay)
          const anchors: Readonly<Record<string, number>> = {
            support_anchor: 0,
            resistance_anchor: 0,
            base_last_bar: 0,
          }
          const response = Result.getOrThrow(
            decodeDecisionsResponse(prepared.request, {
              model: prepared.request.model,
              answers: prepared.request.questions.map((question) =>
                question.type === 'predicate'
                  ? { type: 'predicate', name: question.name, probability: 0.8 }
                  : {
                      type: 'choice',
                      name: question.name,
                      choice: question.choices[anchors[question.name] ?? 0]?.value,
                      confidence: 0.8,
                      probabilities: question.choices.map((choice, index) => ({
                        value: choice.value,
                        probability: index === (anchors[question.name] ?? 0) ? 1 : 0,
                      })),
                    },
              ),
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 0,
                total_tokens: 100,
              },
            }),
          )
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
    }),
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
                    (options.chartTerminalFails || (terminal.stage === 'BASE_START' && options.baseTerminalFails))
                  )
                    return yield* operationalError({
                      component: 'journal',
                      operation: 'test chart terminal commit',
                      message: 'Unavailable',
                    })
                }
                const result =
                  successor.kind === 'NONE'
                    ? { dispatchAllowed: false }
                    : successor.kind === 'VISUAL'
                      ? yield* recordClaim(successor.claim)
                      : yield* recordHandoff(successor.handoff)
                return { requestId, ...result }
              }),
            )
          }),
        ),
    }),
    Layer.succeed(JevClient, {
      evaluate: (input, timeoutMs) =>
        Effect.gen(function* () {
          activeProviders++
          peakProviders = Math.max(peakProviders, activeProviders)
          expect(handoffs.length).toBeGreaterThan(0)
          jevBudgets.push(timeoutMs)
          events.push('jev')
          checkpointEvents.push('jev')
          const prepared = Result.getOrThrow(prepareJevRequest(input))
          expect(durableJevRequests.has(prepared.requestHash)).toBe(true)
          if (options.jevFailure)
            return yield* new JevError({
              failure: JevFailure.Transport,
              message: 'Unavailable',
              requestHash: prepared.requestHash,
            })
          const started = yield* Clock.currentTimeMillis
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
    }),
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

test('durable ready handoff overlaps unrelated base work without changing deadlines or input order', async () => {
  const setup = providers({ baseDelay: 5000, jevDelay: [5000, 0] })
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

test('each Jev dispatch waits for its own durable journal commit', async () => {
  const setup = providers({ baseDelay: 1000, journalCommitDelay: 2000 })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const fiber = yield* evaluateClaimedEntryInferences(mixedDispatches()).pipe(Effect.forkChild)
      yield* TestClock.adjust(1999)
      expect(setup.jevBudgets).toHaveLength(0)
      yield* TestClock.adjust(1)
      expect(setup.jevBudgets).toEqual([8000])
      yield* TestClock.adjust(2999)
      expect(setup.jevBudgets).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(setup.jevBudgets).toEqual([8000, 5000])
    }).pipe(Effect.provide(setup.layer), Effect.provide(TestClock.layer())),
  )
})

test('second journal failure settles the paid sibling and retains its receipt exactly once', async () => {
  const setup = providers({ baseDelay: 1000, baseTerminalFails: true, jevDelay: 2000 })
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
  const setup = providers({ baseDelay: 5000 })
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

test('base provider failure does not discard the independent completed Jev evidence', async () => {
  const setup = providers({ baseFailure: true })
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
      baseDelay: 1000,
      baseTerminalFails: true,
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
