import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { OrderSide } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { JevError, type JevClient } from '../jev/client'
import { JevFailure, prepareJevRequest, type JevRequest } from '../jev/contract'
import { nativeJevFixture, nativeJevInference } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { makeControlJevJournal } from './control-jev-journal'
import { makeControlJevManagement } from './control-jev'
import { controlJevFixture } from './control-jev.test-support'
import { JevClaim } from '../jev/evaluation'
import { JevCandidatePlanStatus } from '../jev/batch'
import { ControlExit, ControlPolicy, ControlStudyFailure } from './control-portfolio'
import { runControlSession, type ControlMarket } from './control-study'

const fixture = nativeJevFixture()
const session = fixture.snapshot.manifest.calendar.sessions[0]
if (session === undefined) throw new Error('Expected fixture calendar')
const openMs = Date.parse(session.openAt)
const closeMs = openMs + 60 * 60_000
const simulate = (
  options: {
    action?: 'hold' | 'exit'
    latencyMs?: number
    sourceLatencyMs?: number
    failed?: boolean
    partial?: boolean
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = `${yield* fs.makeTempDirectoryScoped()}/evidence`
      const providerClock = yield* TestClock.make()
      const marketClock = yield* TestClock.make()
      yield* providerClock.setTime(Date.parse('2026-09-24T21:00:00.000Z'))
      yield* marketClock.setTime(openMs)
      const runId = '3'.repeat(64)
      const journal = yield* makeControlJevJournal(directory, runId)
      const requests: JevRequest[] = []
      const provider: JevClient['Service'] = {
        evaluate: (input) =>
          Effect.gen(function* () {
            requests.push(Result.getOrThrow(prepareJevRequest(input)).request)
            yield* providerClock.adjust(options.latencyMs ?? 125)
            if (options.failed === true)
              return yield* new JevError({ failure: JevFailure.Transport, message: 'Fixture connection failed' })
            return nativeJevInference(
              input,
              new Date(yield* providerClock.currentTimeMillis).toISOString(),
              options.action ?? 'exit',
            )
          }),
      }
      let currentMs = openMs
      const market: ControlMarket = {
        advanceTo: (atMs) =>
          Effect.gen(function* () {
            expect(atMs).toBeGreaterThanOrEqual(currentMs)
            currentMs = atMs
            yield* marketClock.setTime(atMs)
            yield* providerClock.adjust(options.sourceLatencyMs ?? 0)
          }),
        quoteAt: (symbol, atMs) =>
          Effect.sync(() => {
            expect(atMs).toBe(currentMs)
            const original = fixture.snapshot.latestQuotes[symbol]
            if (original === undefined) return undefined
            const at = new Date(atMs).toISOString()
            const value = {
              ...original,
              eventAt: at,
              ingestedAt: at,
              askSize: options.partial === true ? 5 : 1000,
              bidSize: options.partial === true ? 2 : 1000,
            }
            return { value, recordHash: canonicalHashV1(value), availableAtMs: atMs, sequence: 1 }
          }),
        snapshot: (query) =>
          Effect.sync(() => {
            expect(query.candidateEvidencePolicy).toBe(fixture.protocol.candidateEvidencePolicy)
            return {
              status: 'AVAILABLE' as const,
              snapshot: nativeJevFixture(
                query.candidateSymbols?.length === 1 ? JevPurpose.Manage : JevPurpose.Entry,
                query.observedAt,
              ).snapshot,
            }
          }),
      }
      const risk = yield* loadQuoteBoundExecutionRiskPolicy('managed-control-test', fixture.protocol.universe)
      const report = yield* runControlSession({
        policy: ControlPolicy.RelativeMomentum,
        protocol: fixture.protocol,
        risk,
        session: { ...session, closeAt: new Date(closeMs).toISOString() },
        calendar: fixture.snapshot.manifest.calendar,
        openingCapital: {
          cashMicros: '100000000000',
          peakBrokerEquityMicros: '100000000000',
          peakNetEquityMicros: '100000000000',
          accruedExternalCostMicros: '0',
        },
        dataCostMicros: '1000000',
        targetWeight: 0.1,
        decisionLatencyMs: 1000,
        pollIntervalMs: 30_000,
        assumptions: { latencyMs: 100, slippageBps: 1, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
        eligibleSymbols: new Set(fixture.protocol.candidateSymbols),
        market,
        management: {
          runId,
          binding: { journal, provider, providerClock },
          costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
        },
      }).pipe(Effect.provideService(Clock.Clock, marketClock))
      return { report, requests, calls: yield* journal.calls }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

test('a control manages its own partial entry, retries its model exit, and charges measured inference once', async () => {
  const { report, requests, calls } = await simulate({ partial: true })
  expect(report.completion).toBe('COMPLETE')
  expect(report.completedEpisodes).toBeGreaterThan(5)
  const modelEpisodes = report.episodes.filter((episode) => episode.reason === ControlExit.Model)
  expect(modelEpisodes.length).toBe(report.completedEpisodes - 1)
  expect(report.episodes.at(-1)?.reason).toBe(ControlExit.SessionClose)
  expect(report.ledger.positions).toHaveLength(0)
  expect(requests.length).toBe(modelEpisodes.length)
  expect(calls).toHaveLength(requests.length)
  expect(report.orders.filter((order) => order.side === OrderSide.Sell).length).toBe(report.completedEpisodes * 3)
  expect(report.modelCostMicros).toBe(String(requests.length * 5))
  for (const request of requests)
    expect(request.state).toMatchObject({ task: { decisionPurpose: 'MANAGE' }, position: { quantityShares: 5 } })
  expect(BigInt(report.netPnlAfterKnownCostsMicros ?? '0')).toBe(
    BigInt(report.ledger.netRealizedPnlAfterCostsMicros ?? '0') - 1_000_000n - BigInt(requests.length * 5),
  )
  const firstEntry = report.orders.find((order) => order.side === OrderSide.Buy)
  const firstManagement = report.decisions.find((decision) => decision.status === 'MANAGEMENT_EXIT')
  expect(firstEntry).toBeDefined()
  expect(firstManagement?.management).toBeDefined()
  if (firstManagement?.management === undefined) throw new Error('Expected committed management')
  expect(Date.parse(firstManagement.management.committedAt) - Date.parse(firstManagement.observedAt)).toBe(125)
  expect(report.marks.at(-1)?.netEquityAfterKnownCostsMicros).toBe(
    String(BigInt(report.ledger.cashMicros) - 1_000_000n - BigInt(requests.length * 5)),
  )
}, 30_000)

test('source parsing time cannot change management deadlines, fills, or costs', async () => {
  const baseline = await simulate()
  const delayed = await simulate({ sourceLatencyMs: 6000 })
  expect(delayed.report.completion).toBe('COMPLETE')
  expect(delayed.report).toEqual(baseline.report)
  expect(delayed.calls).toHaveLength(baseline.calls.length)
  for (const call of delayed.calls)
    expect(Date.parse(call.providerCompletedAt) - Date.parse(call.providerStartedAt)).toBe(125)
}, 30_000)

test('failed source catch-up rejects management while retaining its paid response', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = controlJevFixture()
      const fs = yield* FileSystem.FileSystem
      const journal = yield* makeControlJevJournal(
        `${yield* fs.makeTempDirectoryScoped()}/journal`,
        fixture.input.runId,
      )
      const providerClock = yield* TestClock.make()
      const marketClock = yield* TestClock.make()
      yield* providerClock.setTime(Date.parse('2026-09-24T21:00:00Z'))
      yield* marketClock.setTime(fixture.atMs)
      const manager = yield* makeControlJevManagement(
        {
          journal,
          providerClock,
          provider: {
            evaluate: (input) =>
              providerClock.currentTimeMillis.pipe(
                Effect.map((atMs) => nativeJevInference(input, new Date(atMs).toISOString(), 'exit')),
              ),
          },
        },
        () => Effect.fail(new ControlStudyFailure({ message: 'Fixture source unavailable' })),
      ).pipe(Effect.provideService(Clock.Clock, marketClock))
      const outcome = yield* manager
        .evaluate(fixture.input, fixture.prepared.controlPortfolio)
        .pipe(Effect.provideService(Clock.Clock, marketClock), Effect.result)
      expect(outcome).toMatchObject({
        _tag: 'Failure',
        failure: { cause: { message: 'Fixture source unavailable' } },
      })
      expect((yield* journal.calls).map((call) => call.outcome.status)).toEqual(['RECEIVED'])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('interruption cancels the provider once, retains its unknown cost, and forbids another call for the pending request', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = controlJevFixture()
      const fs = yield* FileSystem.FileSystem
      const journal = yield* makeControlJevJournal(
        `${yield* fs.makeTempDirectoryScoped()}/journal`,
        fixture.input.runId,
      )
      const providerClock = yield* TestClock.make()
      const marketClock = yield* TestClock.make()
      yield* providerClock.setTime(Date.parse('2026-09-24T21:00:00Z'))
      yield* marketClock.setTime(fixture.atMs)
      const started = yield* Deferred.make<void>()
      let finalized = 0
      const manager = yield* makeControlJevManagement(
        {
          journal,
          providerClock,
          provider: {
            evaluate: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized++
                  }),
                ),
              ),
          },
        },
        (atMs) => marketClock.setTime(atMs),
      ).pipe(Effect.provideService(Clock.Clock, marketClock))
      const evaluation = manager
        .evaluate(fixture.input, fixture.prepared.controlPortfolio)
        .pipe(Effect.provideService(Clock.Clock, marketClock))
      const fiber = yield* evaluation.pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(finalized).toBe(1)
      expect((yield* journal.calls).map((call) => call.outcome.status)).toEqual(['INTERRUPTED'])
      const planned = fixture.prepared.batch.candidates[0]
      if (planned?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected request')
      expect((yield* journal.evaluations.begin(planned.request)).status).toBe(JevClaim.Pending)
      expect((yield* evaluation).status).toBe('UNAVAILABLE')
      expect(yield* journal.calls).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('a provider defect remains a defect after the journal retains its unresolved call', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = controlJevFixture()
      const fs = yield* FileSystem.FileSystem
      const journal = yield* makeControlJevJournal(
        `${yield* fs.makeTempDirectoryScoped()}/journal`,
        fixture.input.runId,
      )
      const providerClock = yield* TestClock.make()
      const marketClock = yield* TestClock.make()
      yield* providerClock.setTime(Date.parse('2026-09-24T21:00:00Z'))
      yield* marketClock.setTime(fixture.atMs)
      const manager = yield* makeControlJevManagement(
        { journal, providerClock, provider: { evaluate: () => Effect.die('Fixture provider defect') } },
        (atMs) => marketClock.setTime(atMs),
      ).pipe(Effect.provideService(Clock.Clock, marketClock))
      const outcome = yield* Effect.exit(
        manager
          .evaluate(fixture.input, fixture.prepared.controlPortfolio)
          .pipe(Effect.provideService(Clock.Clock, marketClock)),
      )
      expect(Exit.isFailure(outcome) && Cause.hasDies(outcome.cause)).toBeTrue()
      expect((yield* journal.calls).map((call) => call.outcome.status)).toEqual(['DEFECT'])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('native hold decisions consume each management window once until a mechanical holding deadline', async () => {
  const { report, requests } = await simulate({ action: 'hold' })
  expect(report.completion).toBe('COMPLETE')
  expect(report.episodes.some((episode) => episode.reason === ControlExit.MaximumHold)).toBeTrue()
  expect(report.episodes.every((episode) => episode.reason !== ControlExit.Model)).toBeTrue()
  const decisions = report.decisions.filter((decision) => decision.status === 'MANAGEMENT_HOLD')
  expect(requests).toHaveLength(decisions.length)
  const windows = decisions.map((decision) =>
    Math.floor((Date.parse(decision.observedAt) - fixture.protocol.decisionDelaySeconds * 1000) / 60_000),
  )
  expect(new Set(windows).size).toBe(windows.length)
}, 30_000)

test('an expired paid response cannot trigger a model exit and still contributes known costs', async () => {
  const { report, calls } = await simulate({ latencyMs: fixture.protocol.inferenceValidityMs })
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.issues).toContain('UNAVAILABLE_MANAGEMENT')
  expect(report.episodes.every((episode) => episode.reason !== ControlExit.Model)).toBeTrue()
  expect(calls.length).toBeGreaterThan(0)
  expect(report.modelCostMicros).toBe(String(calls.length * 5))
  expect(report.ledger.positions).toHaveLength(0)
}, 30_000)

test('provider failures remain unpriced and cannot silently become a complete mechanical study', async () => {
  const { report, calls } = await simulate({ failed: true })
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.issues).toContain('UNPRICED_MODEL_CALLS')
  expect(report.modelCostMicros).toBeNull()
  expect(report.unpricedModelCallCount).toBe(calls.length)
  expect(report.episodes.every((episode) => episode.reason !== ControlExit.Model)).toBeTrue()
  expect(report.ledger.positions).toHaveLength(0)
}, 30_000)
