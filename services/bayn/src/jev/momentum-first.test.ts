import { describe, expect, test } from 'bun:test'
import { Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1 } from '../hash'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { jevProtocolIdentityMatches } from '../shadow-decision-contract'
import { loadActiveStrategyProtocol } from '../strategy'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import {
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  JevEntryExclusion,
  makeJevBatchPlan,
  makeJevBatchResult,
} from './batch'
import { JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { decideJevEntry, decideJevManagement, JevManagementAction, jevEntryQuoteMaximumAgeMs } from './decision'
import { JevEvaluationStore } from './evaluation'
import { nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { makeJevObservation } from './observation'
import { JevPurpose } from './portfolio'
import {
  decodeJevProtocol,
  defaultJevProtocolDocument,
  jevBehaviorHash,
  momentumFirstEntryPolicy,
  momentumFirstJevBehaviorHash,
  momentumFirstJevProtocolDocument,
} from './protocol'
import { evaluateJevObservationFromSnapshot } from './runtime'
import { makeJevTradingSignalBatch, reproduceJevTradingSignalBatch } from './trading-signals'

const fixture = (
  premiums: Readonly<Record<string, number>> = { AAPL: 0.02, AMZN: 0.01 },
  purpose = JevPurpose.Entry,
) => {
  const base = nativeJevFixture(purpose)
  const protocol = Result.getOrThrow(decodeJevProtocol(momentumFirstJevProtocolDocument))
  const { snapshot } = streamingFixtureFromRaw(
    makeIntradayMomentumTestSnapshot(protocol, { ...base.query, archiveWatermarks: [] }, premiums),
    base.query,
  )
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: base.observation.payload.cycleId,
      authorityGenerationHash: base.observation.payload.authorityGenerationHash,
      protocol,
      portfolio: base.portfolio,
      snapshot,
    }),
  )
  const input = {
    observation: observation.payload,
    expiresAt: new Date(Date.parse(observation.payload.observedAt) + protocol.inferenceValidityMs).toISOString(),
    planVersion: JevBatchPlanVersion.V4,
  }
  const plan = Result.getOrThrow(makeJevTradingSignalBatch(input))
  const at = new Date(Date.parse(observation.payload.observedAt) + 100).toISOString()
  return { ...base, protocol, snapshot, observation, input, plan, at }
}

const evidence = (
  f: ReturnType<typeof fixture>,
  action: (symbol: string) => string = () => 'enter',
  probability = 0.8,
) => ({
  observation: f.observation.payload,
  batchPlan: f.plan,
  batchResult: nativeJevBatchResult(f.plan, f.at, action, probability),
  decidedAt: f.at,
})

describe('momentum-first Jev admission', () => {
  test.each([
    ['zero own return', 0, -0.01, false],
    ['zero excess return', 0.01, 0.01, false],
    ['negative own return', -0.001, -0.01, false],
    ['negative excess return', 0.001, 0.01, false],
    ['one-micro positive return, displayed as zero bps', 0.00000001, 0, true],
    ['positive own return in a declining benchmark', 0.001, -0.01, true],
  ] as const)('%s uses exact arithmetic', (_, own, benchmark, admitted) => {
    const f = fixture({ AAPL: own, SPY: benchmark })
    const candidate = f.plan.candidates.find(({ symbol }) => symbol === 'AAPL')
    expect(candidate?.status).toBe(admitted ? JevCandidatePlanStatus.Requested : JevCandidatePlanStatus.Excluded)
    if (candidate?.status === JevCandidatePlanStatus.Excluded) expect(candidate.reason).toBe(JevEntryExclusion.Momentum)
    if (admitted) expect(Result.getOrThrow(decideJevEntry(evidence(f))).selectedSymbols).toEqual(['AAPL'])
  })

  test('retains the entire universe and excludes only before constructing model requests', () => {
    const f = fixture()
    expect(f.plan.candidates.map(({ symbol }) => symbol)).toEqual([...f.protocol.candidateSymbols])
    const requested = f.plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
    expect(requested.map(({ symbol }) => symbol)).toEqual(['AAPL', 'AMZN'])
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(f.observation.payload, f.plan))).toEqual(f.plan)
  })

  test('Jev retains probability ranking among eligible signals and lexical ties', () => {
    const f = fixture({ AAPL: 0.01, AMZN: 0.02 })
    const common = evidence(f)
    expect(Result.getOrThrow(decideJevEntry(common)).selectedSymbols).toEqual(['AAPL'])
    const strongerProbability = nativeJevBatchResult(f.plan, f.at, () => 'enter', 0.9)
    const { resultHash: _, ...material } = common.batchResult
    const result = Result.getOrThrow(
      makeJevBatchResult(f.plan, {
        ...material,
        candidates: common.batchResult.candidates.map((candidate) =>
          candidate.symbol === 'AMZN'
            ? strongerProbability.candidates.find((value) => value.symbol === candidate.symbol)
            : candidate,
        ),
      }),
    )
    expect(Result.getOrThrow(decideJevEntry({ ...common, batchResult: result })).selectedSymbols).toEqual(['AMZN'])
  })

  test.each(['wait', 'avoid'])('a Jev %s cannot be promoted by momentum', (action) => {
    const f = fixture()
    expect(Result.getOrThrow(decideJevEntry(evidence(f, () => action))).selectedSymbols).toEqual([])
  })

  test('preserves the 0.65 acceptance boundary and fixed weight', () => {
    const f = fixture()
    expect(Result.getOrThrow(decideJevEntry(evidence(f, () => 'enter', 0.649))).selectedSymbols).toEqual([])
    const decision = Result.getOrThrow(decideJevEntry(evidence(f, () => 'enter', 0.65)))
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    expect(decision.targetWeights['AAPL']).toBe(0.2)
    expect(jevEntryQuoteMaximumAgeMs(decision, f.at, 10_000)).toBe(10_000)
  })

  test('management still requests a negative-momentum held symbol and preserves hold/exit', () => {
    const f = fixture({ AAPL: -0.02 }, JevPurpose.Manage)
    expect(f.plan.candidates.map(({ status }) => status)).toEqual([JevCandidatePlanStatus.Requested])
    expect(Result.getOrThrow(decideJevManagement(evidence(f, () => 'hold'))).action).toBe(JevManagementAction.Hold)
    expect(Result.getOrThrow(decideJevManagement(evidence(f, () => 'exit'))).action).toBe(JevManagementAction.Exit)
  })

  test('requires every requested result and rejects late complete results', () => {
    const f = fixture()
    const common = evidence(f)
    const { resultHash: _, ...material } = common.batchResult
    const incomplete = makeJevBatchResult(f.plan, {
      ...material,
      candidates: common.batchResult.candidates.map((candidate) =>
        candidate.status === JevCandidateResultStatus.Resolved && candidate.symbol === 'AMZN'
          ? { status: JevCandidateResultStatus.Unattempted, symbol: candidate.symbol, requestId: candidate.requestId }
          : candidate,
      ),
    })
    expect(Result.isFailure(incomplete)).toBe(true)
    expect(Result.isFailure(decideJevEntry({ ...common, decidedAt: f.plan.expiresAt }))).toBe(true)
  })

  test('all valid non-signals run through the native runtime with zero provider calls', async () => {
    const f = fixture({})
    const unused = Effect.die('Excluded candidates must never call the provider or claim evaluations')
    let committed = 0
    const observed = await Effect.runPromise(
      TestClock.setTime(Date.parse(f.at)).pipe(
        Effect.andThen(
          evaluateJevObservationFromSnapshot(
            {
              cycleId: f.observation.payload.cycleId,
              authorityGenerationHash: f.observation.payload.authorityGenerationHash,
              protocol: f.protocol,
              portfolio: f.portfolio,
            },
            f.snapshot.manifest.rangeEndAt,
            Effect.succeed(f.snapshot),
          ),
        ),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.void,
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(JevBatchStore, {
          pending: () => Effect.succeed([]),
          read: () => unused,
          begin: (plan) =>
            Effect.sync(() => {
              committed += 1
              expect(plan.schemaVersion).toBe(JevBatchPlanVersion.V4)
              expect(plan.candidates.every(({ status }) => status === JevCandidatePlanStatus.Excluded)).toBe(true)
              return { plan, result: null }
            }),
          finish: () => Effect.succeed({ plan: f.plan, result: nativeJevBatchResult(f.plan, f.at) }),
        }),
        Effect.provideService(JevEvaluationStore, {
          read: () => unused,
          begin: () => unused,
          record: () => unused,
          abandon: () => unused,
        }),
        Effect.provideService(JevClient, { evaluate: () => unused }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(committed).toBe(1)
    expect(Result.getOrThrow(decideJevEntry(observed.evidence)).selectedSymbols).toEqual([])
  })

  test('fails closed on unknown input and forged exclusions', () => {
    const f = fixture()
    const { batchId: _, ...material } = f.plan
    expect(
      Result.isFailure(
        makeJevTradingSignalBatch({
          ...f.input,
          observation: { ...f.observation.payload, rows: { ...f.observation.payload.rows, quotes: [] } },
        }),
      ),
    ).toBe(true)
    const forged = Result.getOrThrow(
      makeJevBatchPlan({
        ...material,
        candidates: f.plan.candidates.map((candidate) => ({
          symbol: candidate.symbol,
          status: JevCandidatePlanStatus.Excluded,
          reason: JevEntryExclusion.Momentum,
          message: 'Forged no-signal',
        })),
      }),
    )
    expect(Result.isFailure(reproduceJevTradingSignalBatch(f.observation.payload, forged))).toBe(true)
  })

  test('source-unavailable plus valid non-signals is not a verified no-entry batch', () => {
    const f = fixture({})
    const staleAt = new Date(Date.parse(f.snapshot.manifest.observedAt) - 20_000).toISOString()
    const { snapshot } = streamingFixtureFromRaw(
      {
        ...f.snapshot,
        quotes: f.snapshot.quotes.map((quote) =>
          quote.symbol === 'AMD' ? { ...quote, eventAt: staleAt, ingestedAt: staleAt } : quote,
        ),
      },
      f.query,
    )
    const observation = Result.getOrThrow(
      makeJevObservation({
        cycleId: f.observation.payload.cycleId,
        authorityGenerationHash: f.observation.payload.authorityGenerationHash,
        protocol: f.protocol,
        portfolio: f.portfolio,
        snapshot,
      }),
    )
    const plan = Result.getOrThrow(makeJevTradingSignalBatch({ ...f.input, observation: observation.payload }))
    expect(plan.candidates.find(({ symbol }) => symbol === 'AMD')).toMatchObject({
      status: JevCandidatePlanStatus.Excluded,
      reason: 'freshness',
    })
    expect(plan.candidates.every(({ status }) => status === JevCandidatePlanStatus.Excluded)).toBe(true)
    expect(
      Result.isFailure(
        decideJevEntry({
          observation: observation.payload,
          batchPlan: plan,
          batchResult: nativeJevBatchResult(plan, f.at),
          decidedAt: f.at,
        }),
      ),
    ).toBe(true)
  })

  test('new policy identity cannot reuse old protocol versions, batch versions or grants', () => {
    const f = fixture()
    const { batchId: _, ...material } = f.plan
    expect(Result.getOrThrow(loadActiveStrategyProtocol())).toEqual(momentumFirstJevProtocolDocument)
    expect(
      Result.isFailure(
        decodeJevProtocol({ ...defaultJevProtocolDocument, entrySignalPolicy: momentumFirstEntryPolicy }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v2' })),
    ).toBe(true)
    const identity = (behaviorHash: string) =>
      Result.getOrThrow(
        makeStrategyProtocolHashResult({
          name: 'jev',
          behaviorHash,
          parameterHash: canonicalHashV1(f.protocol),
          parameterSchemaVersion: f.protocol.schemaVersion,
        }),
      )
    expect(jevProtocolIdentityMatches(f.protocol, identity(momentumFirstJevBehaviorHash), JevBatchPlanVersion.V4)).toBe(
      true,
    )
    expect(jevProtocolIdentityMatches(f.protocol, identity(jevBehaviorHash), JevBatchPlanVersion.V4)).toBe(false)
    expect(jevProtocolIdentityMatches(f.protocol, f.draft.identity.strategyProtocolHash, JevBatchPlanVersion.V4)).toBe(
      false,
    )
    const old = nativeJevFixture()
    // Produced by the unchanged batch constructor at c29360ebc before the v4 policy.
    const retainedHashes = {
      [JevBatchPlanVersion.V1]: '85aca38156bf2dd1b8fed55c1c3943f398ae5deb8432cb6b69c71f886dbb6c59',
      [JevBatchPlanVersion.V2]: '1cb65f58185d570feb305cfeb58d63a6c010b32a4e35bf6bb803c976596c9ab7',
      [JevBatchPlanVersion.V3]: '773a44f4e4b70835dcd92411e2f21f2fb79aa47675839ff5fee7bd9ca6f7d779',
    }
    for (const version of [JevBatchPlanVersion.V1, JevBatchPlanVersion.V2, JevBatchPlanVersion.V3] as const) {
      expect(Result.isFailure(makeJevTradingSignalBatch({ ...f.input, planVersion: version }))).toBe(true)
      expect(Result.isFailure(makeJevBatchPlan({ ...material, schemaVersion: version }))).toBe(true)
      const retained = Result.getOrThrow(
        makeJevTradingSignalBatch({ ...f.input, observation: old.observation.payload, planVersion: version }),
      )
      expect(retained.batchId).toBe(retainedHashes[version])
      expect(Result.getOrThrow(reproduceJevTradingSignalBatch(old.observation.payload, retained))).toEqual(retained)
      expect(retained.candidates.every(({ status }) => status === JevCandidatePlanStatus.Requested)).toBe(true)
      const oldAapl = retained.candidates.find(({ symbol }) => symbol === 'AAPL')
      const newAapl = f.plan.candidates.find(({ symbol }) => symbol === 'AAPL')
      if (oldAapl?.status !== JevCandidatePlanStatus.Requested || newAapl?.status !== JevCandidatePlanStatus.Requested)
        throw new Error('Expected AAPL requests')
      // Identical surviving observations do not silently change the model-facing hypothesis.
      expect(oldAapl.request.request).toEqual(newAapl.request.request)
      expect(oldAapl.request.requestHash).toBe(newAapl.request.requestHash)
      expect(oldAapl.request.requestId).toBe(newAapl.request.requestId)
    }
    expect(Result.isFailure(makeJevTradingSignalBatch({ ...f.input, observation: old.observation.payload }))).toBe(true)
  })
})
