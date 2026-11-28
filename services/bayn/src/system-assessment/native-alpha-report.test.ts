import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { BacktestInputV12Schema, BacktestIssue, prepareBacktest } from '../intraday-replay/backtest'
import { replayAlphaObservationFixture } from '../intraday-replay/alpha-baseline-use.test-support'
import { gapFixture, gapSourceFixture } from '../intraday-replay/gap-recovery.test-support'
import { registeredStrategyReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { validateBacktestSourceReceipt } from '../intraday-replay/source'
import { JevResearchPolicy } from '../jev/acceptance'
import { jevModel } from '../jev/contract'
import { jevInstructions } from '../jev/instructions'
import { MarketSourcesSchema } from '../market-data/streaming/raw-events'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { nativeAlphaDecisionFixture } from '../strategy/intraday-alpha/alpha-decision.test-support'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import { replayTestInstruments } from '../testing/replay-instruments'
import { config } from '../testing/runtime-fixtures'
import { deriveAlphaBaselineSources } from './alpha-observation-witness'
import { testHash, withRegistrationCommitments } from './fixtures.test-support'
import { completeLatencyArtifactFixture } from './latency-report.test-support'
import { bindLatencyStressSources } from './latency-report'
import { latencyReplayExecutionModelHash } from './latency-replay'
import { alphaLatencyFixture } from './native-alpha-latency.test-support'
import { registeredAllocationMicros } from './policy'

/** Self-declared synthetic artifacts exercise strict reproduction; no image or execution attestation is invented. */
const fixture = () => {
  const f = alphaLatencyFixture({}, preparedAlphaBaselineFixture().payload.acquisition.trailingBaseline)
  const assumptions = {
    instruments: replayTestInstruments,
    latencyMs: 0,
    slippageBps: 0,
    availableLiquidityPpm: 1000000,
    feeMultiplierPpm: 1000000,
  }
  const registration = withRegistrationCommitments({
    ...f.registration,
    latencyReplayExecutionModelHash: Result.getOrThrow(
      latencyReplayExecutionModelHash({ assumptions, fractionalTrading: false }),
    ),
  })
  const cut = { ...f.cut, registrationHash: testHash(registration) }
  const definition = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
  const first = registration.calendar.sessions[0]
  const last = registration.calendar.sessions.at(-1)
  if (definition === undefined || first === undefined || last === undefined)
    throw new Error('Missing synthetic alpha registration')
  const configuration = registration.obligations.configuration
  const captured = gapSourceFixture(gapFixture().today, Date.parse(first.openAt), Date.parse(last.closeAt))
  const marketSources = Schema.decodeUnknownSync(MarketSourcesSchema)(
    configuration.protocol.marketProfiles.map((profile) => ({
      universeId: profile.universeId,
      universeSymbolHash: profile.universeSymbolHash,
      symbols: profile.universe,
      topics: { ...profile.sourceTopics, features: profile.streamingInput.featureTopic },
    })),
  )
  const nativeVisiblePartitions = [...new Set(marketSources.flatMap((market) => Object.values(market.topics)))]
    .sort()
    .map((topic) => ({ topic, partition: 0 }))
  const source = {
    ...captured.manifest,
    marketSources,
    nativeVisiblePartitions,
    positions: nativeVisiblePartitions.map(
      ({ topic, partition }) =>
        captured.manifest.positions.find(
          (position) => position.topic === topic && position.partition === partition,
        ) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  const receipt = JSON.stringify({
    ...captured.receipt.value,
    marketSources: source.marketSources,
    positions: source.positions,
    nativeVisiblePartitions,
  })
  const capture = Result.getOrThrow(validateBacktestSourceReceipt(receipt, sha256(receipt)))
  const { verification: _verification, ...baseBuild } = config.build
  const build = {
    ...baseBuild,
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
  const input = Schema.decodeUnknownSync(BacktestInputV12Schema)({
    schemaVersion: 'bayn.backtest.v12',
    policy: JevResearchPolicy.Candidate,
    strategyBinding: definition.strategyBinding,
    alphaBaselineSources: Result.getOrThrow(deriveAlphaBaselineSources(cut)),
    latencyStress: { registration, sourceCut: cut, brokerIdentity: f.identity },
    jevInstructionsHash: testHash(jevInstructions),
    replicate: 'synthetic-alpha-report',
    inference: {
      mode: 'retained-responses',
      recording,
      recordingHash: testHash(recording),
      maximumCalls: 100,
      models: { jev: jevModel },
      inputDefinition: configuration.protocol.inputDefinition,
      costs: Result.getOrThrow(
        registeredStrategyReplayInferenceTariff(definition.inferenceRateCard, interval, definition.strategyBinding),
      ),
    },
    allocatedDataCostPerSessionMicros: '0',
    interval,
    source,
    openingCashMicros: registeredAllocationMicros(registration),
    fractionalTrading: false,
    calendar: ['2026-09-04', '2026-09-08', '2026-09-09'].map((date) => ({
      date,
      open: '09:30',
      close: '16:00',
      session_open: '0930',
      session_close: '1600',
    })),
    assets: configuration.protocol.universe.map((symbol, index) => ({
      id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
      symbol,
      class: instrumentMarket(symbol) === MarketKind.Equity ? 'us_equity' : 'crypto',
      exchange: instrumentMarket(symbol) === MarketKind.Equity ? 'NASDAQ' : 'CRYPTO',
      status: 'active',
      tradable: true,
      fractionable: true,
      ...(instrumentMarket(symbol) === MarketKind.Crypto
        ? { min_order_size: '0.00001', min_trade_increment: '0.000000001', price_increment: '0.01' }
        : {}),
    })),
    assetObservationAt: first.openAt,
    assetObservationPolicy: 'retained-as-of-session',
    build,
    assumptions,
    cadence: {
      pollIntervalMs: 30000,
      reconciliationIntervalMs: configuration.reconciliationIntervalMs,
      reconciliationPassTimeoutMs: configuration.operationTimeoutMs,
      reconciliationStaleThresholdMs: configuration.reconciliationStaleThresholdMs,
    },
  })
  const prepared = Result.getOrThrowWith(prepareBacktest(input, capture), (cause) => cause)
  const artifact = completeLatencyArtifactFixture({ input, prepared, registration, cut, capture, source, first, last })
  const current = makeAlphaStreamingSnapshot({ minutesFromOpen: 61, profiles: {} })
  const observation = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: testHash('synthetic replay alpha cycle'),
      authorityGenerationHash: testHash('synthetic replay authority'),
      protocol: configuration.protocol,
      portfolio: makeFlatAlphaPortfolio(current.observedAt, undefined, undefined, `replay-${prepared.runId}`),
      snapshot: current.snapshot,
      trailingBaseline: f.owned.payload.trailingBaseline,
    }),
  )
  const at = (delta: number) => new Date(Date.parse(current.observedAt) + delta).toISOString()
  const baselineSource = input.alphaBaselineSources[0]
  if (baselineSource === undefined) throw new Error('Missing synthetic baseline source')
  const report = {
    ...artifact.report,
    alphaObservations: [
      replayAlphaObservationFixture(
        { contentHash: observation.contentHash, payload: observation.payload },
        baselineSource,
        { commandIssuedAt: at(-10) },
      ),
    ],
    alphaBaselineGaps: [],
    decisions: [],
    latencyStress: {
      ...artifact.report.latencyStress,
      admittedObservationCount: 1,
      observationReceipts: [
        {
          observationHash: observation.contentHash,
          commandIssuedAt: at(-10),
          observedAt: at(0),
          completedAt: at(10),
          releaseFloorAt: at(110),
          releasedAt: at(110),
        },
      ],
    },
  }
  const bind = (value: unknown) => {
    const reportHash = testHash(value)
    const reportFileHash = artifact.retain({
      ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value),
      reportHash,
    })
    artifact.sources.add(reportFileHash)
    return bindLatencyStressSources(
      [{ ...artifact.descriptor, reportFileHash }],
      registration,
      cut,
      artifact.artifacts,
      artifact.sources,
    )
  }
  return { input, report, bind, observation, at }
}

test('v10 native alpha report binds full registered evidence and cannot borrow a different source, clock or provider', async () => {
  const f = fixture()
  const verified = Result.getOrThrowWith(f.bind(f.report), (cause) => new Error(JSON.stringify(cause)))
  expect(verified).toHaveLength(1)
  expect(verified[0]?.economics).toBeNull()
  const native = await nativeAlphaDecisionFixture({ accountId: `replay-${f.report.runId}` })
  if (native.document.strategyDecision?.schemaVersion !== 'bayn.intraday-alpha-target.v2')
    throw new Error('Missing genuine native alpha decision')
  expect(native.document.targetPlan.intentTargets).toHaveLength(4)
  const observation = native.document.strategyDecision.evidence.observation
  const observationHash = testHash(observation)
  const at = (delta: number) => new Date(Date.parse(observation.observedAt) + delta).toISOString()
  const nativeReport = {
    ...f.report,
    alphaObservations: [
      replayAlphaObservationFixture(
        { contentHash: observationHash, payload: observation },
        f.input.alphaBaselineSources[0] ??
          (() => {
            throw new Error('Missing synthetic baseline source')
          })(),
      ),
    ],
    decisions: [native.document],
    latencyStress: {
      ...f.report.latencyStress,
      observationReceipts: [
        {
          observationHash,
          commandIssuedAt: at(0),
          observedAt: at(0),
          completedAt: at(100),
          releaseFloorAt: at(120),
          releasedAt: at(120),
        },
      ],
    },
  }
  expect(
    Result.getOrThrowWith(f.bind(nativeReport), (cause) => new Error(JSON.stringify(cause)))[0]?.economics,
  ).toBeNull()
  for (const report of [
    { ...f.report, schemaVersion: 'bayn.backtest-report.v9' },
    { ...f.report, alphaObservations: [] },
    { ...f.report, alphaObservations: [f.report.alphaObservations[0], f.report.alphaObservations[0]] },
    {
      ...f.report,
      alphaObservations: [{ ...f.report.alphaObservations[0], contentHash: testHash('different alpha source') }],
    },
    {
      ...f.report,
      alphaObservations: f.report.alphaObservations.map((row) => ({
        ...row,
        baselineUse: {
          ...row.baselineUse,
          commandIssuedAt: f.at(-11),
        },
      })),
    },
    {
      ...f.report,
      alphaObservations: f.report.alphaObservations.map(({ baselineUse: _unbound, ...row }) => row),
    },
    { ...f.report, inference: { ...f.report.inference, providerDispatchCount: 1 } },
    { ...f.report, decisions: [{}] },
    {
      ...f.report,
      latencyStress: {
        ...f.report.latencyStress,
        observationReceipts: f.report.latencyStress.observationReceipts.map((r) => ({ ...r, releasedAt: f.at(10) })),
      },
    },
  ])
    expect(Result.isFailure(f.bind(report))).toBe(true)
}, 60000)

test('v10 native alpha report preserves missing first-cut baselines as incomplete and rejects an erased denominator', () => {
  const f = fixture()
  const baseline = f.input.alphaBaselineSources[0]
  if (baseline === undefined) throw new Error('Missing synthetic alpha source')
  const incomplete = {
    ...f.report,
    completion: 'INCOMPLETE',
    issues: [BacktestIssue.MissingCausalAlphaBaseline],
    alphaBaselineGaps: [
      {
        reason: 'MISSING_CAUSAL_ALPHA_BASELINE',
        sessionDate: baseline.payload.trailingBaseline.sessionDate,
        observedAt: baseline.payload.observedAt,
        firstAvailableAt: baseline.availableAt,
      },
    ],
  }
  expect(
    Result.getOrThrowWith(f.bind(incomplete), (cause) => new Error(JSON.stringify(cause)))[0]?.economics,
  ).toBeNull()
  for (const report of [
    { ...incomplete, completion: 'COMPLETE' },
    { ...incomplete, alphaBaselineGaps: [] },
    { ...incomplete, issues: [] },
    {
      ...incomplete,
      alphaBaselineGaps: incomplete.alphaBaselineGaps.map((gap) => ({ ...gap, observedAt: baseline.availableAt })),
    },
  ])
    expect(Result.isFailure(f.bind(report))).toBe(true)
}, 60000)
