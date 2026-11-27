import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { BacktestInputV12Schema } from '../intraday-replay/backtest'
import { registeredStrategyReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { alphaReplayBaselineFixture } from '../intraday-replay/alpha-replay.test-support'
import { JevResearchPolicy } from '../jev/acceptance'
import { jevModel } from '../jev/contract'
import { jevInstructions } from '../jev/instructions'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { makeFlatAlphaPortfolio, makeTestTrailingBaseline } from '../strategy/intraday-alpha/test-support'
import { currentJevReplayFixture } from '../testing/retained-replay-fixture'
import { replayTestInstruments } from '../testing/replay-instruments'
import { config } from '../testing/runtime-fixtures'
import { deriveAlphaBaselineSources } from './alpha-observation-witness'
import {
  nativeRegistrationFixture,
  registrationFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { bindLatencyReplayInput, latencyReplayExecutionModelHash } from './latency-replay'
import { registeredAllocationMicros } from './policy'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'
import { emptySourceCutFixture } from './source-cut.test-support'
import { ResearchStrategyEngine } from './strategy-binding'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

/** Synthetic binding fixtures; source receipt authentication and execution are tested independently. */
const fixture = (
  policy: JevResearchPolicy.Candidate | JevResearchPolicy.Incumbent = JevResearchPolicy.Candidate,
  engine: ResearchStrategyEngine.Jev | ResearchStrategyEngine.IntradayAlpha = ResearchStrategyEngine.IntradayAlpha,
) => {
  const calendar = ['2026-09-04', '2026-09-08'].map((date) => ({
    date: Schema.decodeUnknownSync(IsoDateSchema)(date),
    open: '09:30',
    close: '16:00',
    session_open: '0800',
    session_close: '1700',
  }))
  const normalized = Result.getOrThrow(
    normalizeMarketCalendarResult(calendar, { start: '2026-09-04', end: '2026-09-08' }),
  )
  const assumptions = {
    instruments: replayTestInstruments,
    latencyMs: 100,
    slippageBps: 0,
    availableLiquidityPpm: 1_000_000,
    feeMultiplierPpm: 1_000_000,
  }
  const base = registrationFixture(undefined, 2)
  const bound = strategyBoundRegistrationFixture(
    nativeRegistrationFixture({ ...base, registeredAt: '2026-09-01T00:00:00.000Z' }, normalized),
    { candidate: engine, incumbent: engine },
  )
  const registration = withRegistrationCommitments({
    ...bound,
    policies: bound.policies.map((definition) => ({
      ...definition,
      inferenceRateCard: {
        ...definition.inferenceRateCard,
        rates: definition.inferenceRateCard.rates.map((rate) => ({
          ...rate,
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveUntil: '2026-09-09T00:00:00.000Z',
        })),
      },
    })),
    latencyReplayExecutionModelHash: Result.getOrThrow(
      latencyReplayExecutionModelHash({ assumptions, fractionalTrading: false }),
    ),
  })
  const candidate = registration.policies.find((definition) => definition.policy === JevResearchPolicy.Candidate)
  const definition = registration.policies.find((entry) => entry.policy === policy)
  const first = registration.calendar.sessions[0]
  const last = registration.calendar.sessions.at(-1)
  if (candidate === undefined || definition === undefined || first === undefined || last === undefined)
    throw new Error('Missing synthetic registered policy or native calendar')
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: candidate.riskPolicy.accountId,
    }),
  )
  const retained = alphaReplayBaselineFixture()
  const owned = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: testHash('synthetic bound alpha observation'),
      authorityGenerationHash: candidate.authorityGenerationHash,
      protocol: registration.obligations.configuration.protocol,
      portfolio: makeFlatAlphaPortfolio(
        retained.input.observedAt,
        undefined,
        undefined,
        candidate.riskPolicy.accountId,
      ),
      snapshot: retained.input.snapshot,
      trailingBaseline: makeTestTrailingBaseline(),
    }),
  )
  const cut = Schema.decodeUnknownSync(
    StrategyBoundSystemSourceCutSchema,
    strictParseOptions,
  )({
    ...emptySourceCutFixture().cut,
    schemaVersion: 'bayn.system-source-cut.v5',
    registrationHash: testHash(registration),
    runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
    asOf: '2026-09-09T00:00:00.000Z',
    alphaObservations:
      engine === ResearchStrategyEngine.IntradayAlpha
        ? [{ contentHash: owned.contentHash, payload: owned.payload }]
        : [],
    durableObservations:
      engine === ResearchStrategyEngine.IntradayAlpha
        ? [
            {
              kind: 'ALPHA_OBSERVATION',
              sourceHash: owned.contentHash,
              sourceAt: owned.payload.observedAt,
              witnessedAt: new Date(Date.parse(owned.payload.observedAt) + 100).toISOString(),
              correct: true,
            },
          ]
        : [],
  })
  const configuration = registration.obligations.configuration
  const source = {
    ...currentJevReplayFixture().manifest,
    transport: 'original-capture',
    marketSources: configuration.protocol.marketProfiles.map((profile) => ({
      universeId: profile.universeId,
      universeSymbolHash: profile.universeSymbolHash,
      symbols: profile.universe,
      topics: { ...profile.sourceTopics, features: profile.streamingInput.featureTopic },
    })),
    deliveryModel: {
      schemaVersion: 'bayn.original-capture-arrivals.v1',
      description: 'Synthetic independently authenticated source binding fixture',
      tieBreak: 'availability-receipt-sequence',
      captureId: 'synthetic-capture',
      consumerEpoch: 'synthetic-epoch',
      exportManifestHash: testHash('synthetic export'),
      intervalReceiptHash: testHash('synthetic interval receipt'),
      finalConsumerSequence: 1,
    },
  }
  const { verification: _verification, ...embeddedBuild } = config.build
  const build = {
    ...embeddedBuild,
    sourceRevision: definition.sourceRevision,
    imageDigest: `sha256:${definition.imageDigest}`,
    strategyBehaviorHash: definition.strategyHash,
    strategyParameterHash: definition.parametersHash,
  }
  const interval = { startAt: first.openAt, endAt: last.closeAt }
  const recording = {
    schemaVersion: 'bayn.replay-inference-recording.v1',
    sourceManifestHash: testHash(source),
    sourceRevision: build.sourceRevision,
    strategyBehaviorHash: build.strategyBehaviorHash,
    strategyParameterHash: build.strategyParameterHash,
    jevInstructionsHash: testHash(jevInstructions),
    calls: [],
  }
  const input = Schema.decodeUnknownSync(
    BacktestInputV12Schema,
    strictParseOptions,
  )({
    schemaVersion: 'bayn.backtest.v12',
    policy,
    strategyBinding: definition.strategyBinding,
    alphaBaselineSources: Result.getOrThrow(deriveAlphaBaselineSources(cut)),
    latencyStress: { registration, sourceCut: cut, brokerIdentity: identity },
    jevInstructionsHash: testHash(jevInstructions),
    inference: {
      mode: 'retained-responses',
      maximumCalls: 1000,
      models: { jev: jevModel },
      inputDefinition: configuration.protocol.inputDefinition,
      costs: Result.getOrThrow(
        registeredStrategyReplayInferenceTariff(definition.inferenceRateCard, interval, definition.strategyBinding),
      ),
      recording,
      recordingHash: testHash(recording),
    },
    allocatedDataCostPerSessionMicros: null,
    replicate: 'synthetic-native-binding-test',
    interval,
    source,
    openingCashMicros: registeredAllocationMicros(registration),
    fractionalTrading: false,
    calendar,
    assets: [
      {
        id: '12345678-1234-4234-8234-000000000000',
        symbol: 'SPY',
        class: 'us_equity',
        exchange: 'ARCA',
        status: 'active',
        tradable: true,
        fractionable: true,
      },
    ],
    assetObservationAt: first.openAt,
    assetObservationPolicy: 'retained-as-of-session',
    build,
    assumptions,
    cadence: {
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: configuration.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: configuration.operationTimeoutMs,
      reconciliationStaleThresholdMs: configuration.reconciliationStaleThresholdMs,
    },
  })
  return { input, registration, identity, cut }
}

describe('registered native strategy latency replay binding', () => {
  test.each([
    [JevResearchPolicy.Candidate, ResearchStrategyEngine.IntradayAlpha],
    [JevResearchPolicy.Incumbent, ResearchStrategyEngine.IntradayAlpha],
    [JevResearchPolicy.Candidate, ResearchStrategyEngine.Jev],
    [JevResearchPolicy.Incumbent, ResearchStrategyEngine.Jev],
  ] as const)('%s executes its explicitly bound %s engine and full native calendar', (role, engine) => {
    const f = fixture(role, engine)
    const windows = Result.getOrThrow(bindLatencyReplayInput(f.input, f.registration, f.identity))
    expect(windows).toEqual(
      f.registration.calendar.sessions.map((s) => ({ date: s.sessionDate, openAt: s.openAt, closeAt: s.closeAt })),
    )
    expect(windows[0]?.openAt).toBe('2026-09-04T12:00:00.000Z')
    expect(f.input.inference.costs.rates.length === 0).toBe(engine === ResearchStrategyEngine.IntradayAlpha)
    // Poll frequency is retained only for old input compatibility; it cannot drive v12 decisions.
    expect(
      Result.getOrThrow(
        bindLatencyReplayInput(
          { ...f.input, cadence: { ...f.input.cadence, pollIntervalMs: 1 } },
          f.registration,
          f.identity,
        ),
      ),
    ).toEqual(windows)
  })

  test('engine substitution, supplied arrival clocks and changed registration commitments fail binding', () => {
    const f = fixture()
    const jev = fixture(JevResearchPolicy.Candidate, ResearchStrategyEngine.Jev)
    for (const input of [
      { ...f.input, strategyBinding: jev.input.strategyBinding },
      { ...f.input, latencyStress: null },
      { ...f.input, latencyStress: { ...f.input.latencyStress!, registration: jev.registration } },
      {
        ...f.input,
        latencyStress: {
          ...f.input.latencyStress!,
          sourceCut: { ...f.cut, registrationHash: testHash('other registration') },
        },
      },
      { ...f.input, source: { ...f.input.source, transport: 'captured-kafka' as const } },
      {
        ...f.input,
        source: {
          ...f.input.source,
          deliveryModel: {
            schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
            description: 'unobserved original availability',
            tieBreak: 'availability-topic-partition-offset' as const,
          },
        },
      },
      { ...f.input, build: { ...f.input.build, sourceRevision: 'b'.repeat(40) } },
      { ...f.input, openingCashMicros: '200000000000' },
      { ...f.input, calendar: f.input.calendar.slice(1) },
      { ...f.input, calendar: f.input.calendar.map((day) => ({ ...day, session_close: '1600' })) },
      { ...f.input, assumptions: { ...f.input.assumptions, slippageBps: 1 } },
      { ...f.input, cadence: { ...f.input.cadence, reconciliationIntervalMs: 1 } },
    ])
      expect(Result.isFailure(bindLatencyReplayInput(input, f.registration, f.identity))).toBe(true)
  })

  test('baseline carriers retain the exact independently witnessed source and availability', () => {
    const f = fixture()
    const source = f.input.alphaBaselineSources[0]
    if (source === undefined) throw new Error('Missing synthetic witnessed alpha baseline')
    for (const alphaBaselineSources of [
      [],
      [{ ...source, availableAt: source.payload.observedAt }],
      [{ ...source, witnessSourceHash: testHash('other witness') }],
      [source, source],
    ])
      expect(
        Result.isFailure(bindLatencyReplayInput({ ...f.input, alphaBaselineSources }, f.registration, f.identity)),
      ).toBe(true)
    const unwitnessed = { ...f.cut, durableObservations: [] }
    expect(
      Result.isFailure(
        bindLatencyReplayInput(
          { ...f.input, latencyStress: { ...f.input.latencyStress!, sourceCut: unwitnessed } },
          f.registration,
          f.identity,
        ),
      ),
    ).toBe(true)
    // Missing witnesses keep the payload visible but unavailable; later preparation must prove full calibration.
    expect(
      Result.isSuccess(
        bindLatencyReplayInput(
          {
            ...f.input,
            alphaBaselineSources: [],
            latencyStress: { ...f.input.latencyStress!, sourceCut: unwitnessed },
          },
          f.registration,
          f.identity,
        ),
      ),
    ).toBe(true)
  })
})
