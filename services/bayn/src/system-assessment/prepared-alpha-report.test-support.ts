import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { instrumentMarket, MarketKind } from '../instruments'
import { preparedReplayAlphaObservationFixture } from '../intraday-replay/alpha-prepared-baseline.test-support'
import { BacktestInputV13Schema, prepareBacktest } from '../intraday-replay/backtest'
import { gapFixture, gapSourceFixture } from '../intraday-replay/gap-recovery.test-support'
import { registeredStrategyReplayInferenceTariff } from '../intraday-replay/inference-costs'
import { validateBacktestSourceReceipt } from '../intraday-replay/source'
import { JevResearchPolicy } from '../jev/acceptance'
import { jevModel } from '../jev/contract'
import { jevInstructions } from '../jev/instructions'
import { MarketSourcesSchema } from '../market-data/streaming/raw-events'
import {
  reproduceAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from '../observe-composition/alpha-baseline-preparation'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { replayTestInstruments } from '../testing/replay-instruments'
import { config } from '../testing/runtime-fixtures'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'
import { testHash, withRegistrationCommitments } from './fixtures.test-support'
import { preparedAlphaSystemLatencyStressProtocolHash } from './latency-protocol'
import { bindLatencyStressSources } from './latency-report'
import { completeLatencyArtifactFixture } from './latency-report.test-support'
import { latencyReplayExecutionModelHash } from './latency-replay'
import { alphaLatencyFixture } from './native-alpha-latency.test-support'
import {
  PreparedAlphaSystemRegistrationSchema,
  preparedAlphaSystemQualificationPolicyHash,
  registeredAllocationMicros,
  type SystemRegistration,
} from './policy'
import { PreparedAlphaSystemSourceCutSchema, type SystemSourceCut } from './source-cut'
import { ResearchStrategyEngine } from './strategy-binding'

/** Synthetic source and self-declared report only; successful binding cannot attest an image or economic result. */
export const preparedAlphaReportFixture = (
  options: {
    readonly policy?: JevResearchPolicy.Candidate | JevResearchPolicy.Incumbent
    readonly changeRecord?: (record: RecordedAlphaBaselinePreparation) => RecordedAlphaBaselinePreparation
    readonly availableAt?: string
  } = {},
) => {
  const policy = options.policy ?? JevResearchPolicy.Candidate
  const base = preparedAlphaBaselineFixture()
  const f = alphaLatencyFixture(
    {
      incumbent:
        policy === JevResearchPolicy.Incumbent ? ResearchStrategyEngine.IntradayAlpha : ResearchStrategyEngine.Jev,
    },
    base.payload.acquisition.trailingBaseline,
  )
  const assumptions = {
    instruments: replayTestInstruments,
    latencyMs: 0,
    slippageBps: 0,
    availableLiquidityPpm: 1000000,
    feeMultiplierPpm: 1000000,
  }
  const registration = Schema.decodeUnknownSync(PreparedAlphaSystemRegistrationSchema)(
    withRegistrationCommitments({
      ...f.registration,
      schemaVersion: 'bayn.system-registration.v7',
      policyHash: Result.getOrThrow(preparedAlphaSystemQualificationPolicyHash()),
      latencyStressProtocolHash: Result.getOrThrow(preparedAlphaSystemLatencyStressProtocolHash()),
      latencyReplayExecutionModelHash: Result.getOrThrow(
        latencyReplayExecutionModelHash({ assumptions, fractionalTrading: false }),
      ),
    }),
  )
  const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
  const definition = registration.policies.find((p) => p.policy === policy)
  const first = registration.calendar.sessions[0]
  const last = registration.calendar.sessions.at(-1)
  if (
    candidate === undefined ||
    definition === undefined ||
    first === undefined ||
    last === undefined ||
    candidate.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha ||
    definition.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha
  )
    throw new Error('Missing synthetic prepared alpha registration')
  const sessionAt = (delta: number) => new Date(Date.parse(first.openAt) + delta).toISOString()
  const produced = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      ...base.payload,
      accountId: candidate.riskPolicy.accountId,
      authorityGenerationHash: candidate.authorityGenerationHash,
      policy: candidate.strategyBinding.parameters,
      calendar: registration.calendar.marketCalendar,
      executionBuild: {
        sourceRevision: candidate.sourceRevision,
        imageRepository:
          candidate.capitalAuthorization?.buildLineage.activation.imageRepository ?? 'registry.example/bayn',
        imageDigest: `sha256:${candidate.imageDigest}`,
      },
      acquisition: { ...base.payload.acquisition, startedAt: sessionAt(1000), completedAt: sessionAt(2000) },
    }),
  )
  const recorded = { contentHash: produced.contentHash, payload: produced.payload, recordedAt: sessionAt(2001) }
  const record = options.changeRecord?.(recorded) ?? recorded
  const calendar = record.payload.calendar
  if (calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2')
    throw new Error('Prepared report fixture requires an actual equity calendar')
  const cut = Schema.decodeUnknownSync(PreparedAlphaSystemSourceCutSchema)({
    ...f.cut,
    schemaVersion: 'bayn.system-source-cut.v6',
    registrationHash: testHash(registration),
    alphaBaselinePreparations: [record],
    durableObservations: [
      ...f.cut.durableObservations,
      {
        kind: 'ALPHA_BASELINE',
        sourceHash: record.contentHash,
        sourceAt: record.recordedAt,
        witnessedAt: options.availableAt ?? sessionAt(3000),
        correct: true,
      },
    ],
  })
  const alphaBaselinePreparations = Result.getOrThrow(derivePreparedAlphaBaselineSources(cut))
  const baseline = alphaBaselinePreparations[0]
  if (baseline === undefined) throw new Error('Missing synthetic prepared source witness')
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
  const input = Schema.decodeUnknownSync(BacktestInputV13Schema)({
    schemaVersion: 'bayn.backtest.v13',
    policy,
    strategyBinding: definition.strategyBinding,
    alphaBaselinePreparations,
    latencyStress: { registration, sourceCut: cut, brokerIdentity: f.identity },
    jevInstructionsHash: testHash(jevInstructions),
    replicate: 'synthetic-prepared-alpha-report',
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
  const prepared = Result.getOrThrowWith(prepareBacktest(input, capture), (cause) => new Error(JSON.stringify(cause)))
  const artifact = completeLatencyArtifactFixture({ input, prepared, registration, cut, capture, source, first, last })
  const current = makeAlphaStreamingSnapshot({
    minutesFromOpen: 61,
    profiles: {},
    snapshotCalendar: calendar,
  })
  const observation = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: testHash('synthetic prepared replay alpha cycle'),
      authorityGenerationHash: testHash('synthetic prepared replay authority'),
      protocol: configuration.protocol,
      portfolio: makeFlatAlphaPortfolio(current.observedAt, undefined, undefined, `replay-${prepared.runId}`),
      snapshot: current.snapshot,
      trailingBaseline: baseline.payload.acquisition.trailingBaseline,
    }),
  )
  const at = (delta: number) => new Date(Date.parse(current.observedAt) + delta).toISOString()
  const stress = prepared.latencyStress
  if (stress === null) throw new Error('Prepared report fixture requires registered latency calibration')
  const receiptFor = (row: ReturnType<typeof preparedReplayAlphaObservationFixture>, completionDelayMs = 10) => {
    const commandIssuedAt = row.baselineUse.commandIssuedAt
    const observedAt = row.payload.observedAt
    const completedAt = new Date(Date.parse(observedAt) + completionDelayMs).toISOString()
    const releaseFloorAt = new Date(Date.parse(commandIssuedAt) + stress.p95FullBatchMs).toISOString()
    return {
      observationHash: row.contentHash,
      commandIssuedAt,
      observedAt,
      completedAt,
      releaseFloorAt,
      releasedAt: completedAt > releaseFloorAt ? completedAt : releaseFloorAt,
    }
  }
  const row = preparedReplayAlphaObservationFixture(observation, baseline)
  const report = {
    ...artifact.report,
    alphaObservations: [row],
    alphaBaselineGaps: [],
    decisions: [],
    latencyStress: {
      ...artifact.report.latencyStress,
      admittedObservationCount: 1,
      observationReceipts: [receiptFor(row)],
    },
  }
  const bind = (
    value: unknown,
    overrides: {
      readonly input?: unknown
      readonly cut?: SystemSourceCut
      readonly registration?: SystemRegistration
    } = {},
  ) => {
    const reportFileHash = artifact.retain({
      ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value),
      reportHash: testHash(value),
    })
    const inputFileHash =
      overrides.input === undefined ? artifact.descriptor.inputFileHash : artifact.retain(overrides.input)
    artifact.sources.add(reportFileHash)
    artifact.sources.add(inputFileHash)
    return bindLatencyStressSources(
      [{ ...artifact.descriptor, reportFileHash, inputFileHash }],
      overrides.registration ?? registration,
      overrides.cut ?? cut,
      artifact.artifacts,
      artifact.sources,
    )
  }
  return {
    input,
    prepared,
    report,
    bind,
    observation,
    at,
    record,
    baseline,
    cut,
    registration,
    candidate,
    definition,
    capture,
    calendar,
    receiptFor,
  }
}
