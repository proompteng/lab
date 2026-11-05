import { Result, Schema } from 'effect'
import { AssetClass, AssetResponseSchema } from '../broker/alpaca/model'
import { normalizeAssetResult, normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { EmbeddedBuildMetadataSchema } from '../build'
import { canonicalHashV1Result, sha256 } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { ExecutionModelV6Schema } from '../execution-model-contract'
import { ReplayInstrumentsSchema } from '../intraday-replay/execution-core'
import {
  ImageDigestSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { SystemAssessmentError } from './economics'
import {
  SystemLatencyReplaySchema,
  prepareSystemLatencyReplay,
  latencyReplayExecutionModelHash,
} from './latency-replay'
import { frozenControlOrigin, frozenDeployedControlIdentity } from './frozen-control-identity'
import { registeredAllocationMicros } from './policy'

const Universe = Schema.Struct({
  universeId: StrictNonEmptyStringSchema,
  universeSymbolHash: Sha256Schema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  topics: Schema.Struct({
    bars: StrictNonEmptyStringSchema,
    quotes: StrictNonEmptyStringSchema,
    trades: StrictNonEmptyStringSchema,
    features: StrictNonEmptyStringSchema,
    technicalFeatures: Schema.optionalKey(StrictNonEmptyStringSchema),
  }),
})
const Positions = Schema.Array(
  Schema.Struct({
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    startOffset: UnsignedMicrosSchema,
    endOffsetExclusive: UnsignedMicrosSchema,
  }),
).check(Schema.isMinLength(1))
const OriginalMarketTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))

/** Original captured-arrival wire format, consumed only by the pinned offline engine. */
export const FrozenControlSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest-source.v1'),
  encoding: Schema.Literal('ndjson-gzip'),
  transport: Schema.Literal('captured-kafka'),
  dataSha256: Sha256Schema,
  recordCount: PositiveIntegerSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  firstAvailableAtMs: NonNegativeIntegerSchema,
  lastAvailableAtMs: NonNegativeIntegerSchema,
  origin: StrictNonEmptyStringSchema,
  positions: Positions,
  universe: Universe,
  deliveryModel: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.supplied-arrival-times.v1'),
    description: StrictNonEmptyStringSchema,
    tieBreak: Schema.Literal('availability-topic-partition-offset'),
  }),
  regeneratedFeaturesRecordedAtMs: Schema.optionalKey(NonNegativeIntegerSchema),
})
const Capture = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-source-capture.v1'),
  capturedAt: UtcInstantSchema,
  origin: StrictNonEmptyStringSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  universe: Universe,
  positions: Positions,
})
export const FrozenControlBacktestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest.v1'),
  replicate: StrictNonEmptyStringSchema,
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  source: FrozenControlSourceSchema,
  openingCashMicros: PositiveMicrosSchema,
  fractionalTrading: Schema.Boolean,
  calendar: Schema.Array(Schema.Struct({ date: IsoDateSchema, open: OriginalMarketTime, close: OriginalMarketTime })),
  assets: Schema.Array(
    Schema.Struct({ ...AssetResponseSchema.fields, class: Schema.Literal(AssetClass.UsEquity) }),
  ).check(Schema.isMinLength(1)),
  assetObservationAt: UtcInstantSchema,
  assetObservationPolicy: Schema.Literal('retained-as-of-session'),
  build: Schema.Struct({ ...EmbeddedBuildMetadataSchema.fields, imageDigest: ImageDigestSchema }),
  assumptions: Schema.Struct({
    latencyMs: NonNegativeIntegerSchema,
    slippageBps: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(10000)),
    availableLiquidityPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000000)),
    feeMultiplierPpm: Schema.Int.check(Schema.isBetween({ minimum: 1000000, maximum: 10000000 })),
  }),
  cadence: Schema.Struct({
    pollIntervalMs: PositiveIntegerSchema,
    reconciliationIntervalMs: PositiveIntegerSchema,
    reconciliationPassTimeoutMs: PositiveIntegerSchema,
    reconciliationStaleThresholdMs: PositiveIntegerSchema,
  }),
})
export const FrozenControlReplaySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.frozen-control-replay.v1'),
  policy: Schema.Literal(JevResearchPolicy.Deployed),
  protocol: Schema.Record(Schema.String, Schema.Unknown),
  executionInstruments: ReplayInstrumentsSchema,
  backtest: FrozenControlBacktestSchema,
  latencyStress: Schema.Struct({ ...SystemLatencyReplaySchema.fields, p95FullBatchMs: NonNegativeIntegerSchema }),
})

// Hash the entire protocol before projecting the fields this verifier uses.
const Protocol = Schema.Struct({
  schemaVersion: Schema.Literal(frozenControlOrigin.parameterSchemaVersion),
  universe: Schema.Array(SymbolSchema),
  universeId: StrictNonEmptyStringSchema,
  universeSymbolHash: Sha256Schema,
  sourceTopics: Schema.Struct({
    bars: StrictNonEmptyStringSchema,
    quotes: StrictNonEmptyStringSchema,
    trades: StrictNonEmptyStringSchema,
  }),
  streamingInput: Schema.Struct({ featureTopic: StrictNonEmptyStringSchema }),
  executionModel: Schema.Struct({ fees: ExecutionModelV6Schema.fields.fees }),
})

export const frozenReplayReplica = (input: typeof FrozenControlReplaySchema.Type, captureHash: string) => {
  const { replicate: _replicate, ...backtest } = input.backtest
  return canonicalHashV1Result({
    schemaVersion: 'bayn.frozen-control-replica.v1',
    policy: input.policy,
    protocol: input.protocol,
    executionInstruments: input.executionInstruments,
    backtest,
    latencyStress: input.latencyStress,
    captureHash,
  })
}

/** Authenticate the original policy, complete calibration and registered scope before invoking its isolated engine. */
export const prepareFrozenControlReplay = (raw: unknown, captureText: string, captureHash: string) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const input = yield* Schema.decodeUnknownResult(FrozenControlReplaySchema, strictParseOptions)(raw)
    if (sha256(captureText) !== captureHash)
      return yield* fail('Frozen control capture bytes differ from their pinned hash')
    const capture = yield* Schema.decodeUnknownResult(Schema.fromJsonString(Capture), strictParseOptions)(captureText)
    const stress = yield* prepareSystemLatencyReplay(input.latencyStress)
    const registration = stress.registration
    const definition = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Deployed)
    const first = registration.calendar.sessions[0]
    const last = registration.calendar.sessions.at(-1)
    if (definition === undefined || first === undefined || last === undefined)
      return yield* fail('Frozen replay requires its registered policy and full calendar')
    const protocol = yield* Schema.decodeUnknownResult(Protocol)(input.protocol)
    const executionModel = input.protocol['executionModel']
    if (
      (yield* canonicalHashV1Result(input.protocol)) !== frozenDeployedControlIdentity.parametersHash ||
      (yield* canonicalHashV1Result(executionModel)) !== frozenControlOrigin.executionModelHash ||
      input.backtest.build.sourceRevision !== definition.sourceRevision ||
      input.backtest.build.imageDigest !== `sha256:${definition.imageDigest}` ||
      input.backtest.build.strategyBehaviorHash !== definition.strategyHash ||
      input.backtest.build.strategyParameterHash !== definition.parametersHash ||
      input.backtest.openingCashMicros !== registeredAllocationMicros(registration) ||
      input.latencyStress.p95FullBatchMs !== stress.p95FullBatchMs ||
      input.backtest.replicate !== (yield* frozenReplayReplica(input, captureHash)) ||
      (yield* latencyReplayExecutionModelHash({
        fractionalTrading: input.backtest.fractionalTrading,
        assumptions: { ...input.backtest.assumptions, instruments: input.executionInstruments },
      })) !== registration.latencyReplayExecutionModelHash
    )
      return yield* fail('Frozen replay changed its registered policy, execution assumptions, release floor or replica')
    const expectedUniverse = {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: { ...protocol.sourceTopics, features: protocol.streamingInput.featureTopic },
    }
    if (
      (yield* canonicalHashV1Result(input.backtest.source.universe)) !==
        (yield* canonicalHashV1Result(expectedUniverse)) ||
      (yield* canonicalHashV1Result(capture.universe)) !== (yield* canonicalHashV1Result(expectedUniverse)) ||
      (yield* canonicalHashV1Result(capture.positions)) !==
        (yield* canonicalHashV1Result(input.backtest.source.positions)) ||
      capture.coverageStartMs !== input.backtest.source.coverageStartMs ||
      capture.coverageEndMs !== input.backtest.source.coverageEndMs ||
      capture.coverageStartMs > Date.parse(first.openAt) ||
      capture.coverageEndMs < Date.parse(last.closeAt) ||
      Date.parse(capture.capturedAt) < capture.coverageEndMs ||
      capture.capturedAt > input.latencyStress.sourceCut.asOf ||
      input.backtest.assetObservationAt > first.openAt ||
      (yield* canonicalHashV1Result(input.backtest.sessionDates)) !==
        (yield* canonicalHashV1Result(registration.calendar.sessions.map((session) => session.sessionDate)))
    )
      return yield* fail('Frozen replay source, availability, assets or sessions differ from the locked scope')
    const configuration = registration.obligations.configuration
    if (
      input.backtest.cadence.pollIntervalMs !== configuration.cyclePollIntervalMs ||
      input.backtest.cadence.reconciliationIntervalMs !== configuration.reconciliationIntervalMs ||
      input.backtest.cadence.reconciliationPassTimeoutMs !== configuration.operationTimeoutMs ||
      input.backtest.cadence.reconciliationStaleThresholdMs !== configuration.reconciliationStaleThresholdMs
    )
      return yield* fail('Frozen replay cannot change registered operational deadlines')
    const calendar = yield* normalizeMarketCalendarResult(
      input.backtest.calendar
        .filter((day) => day.date >= first.sessionDate && day.date <= last.sessionDate)
        .map((day) => ({ ...day, session_open: day.open.replace(':', ''), session_close: day.close.replace(':', '') })),
      { start: first.sessionDate, end: last.sessionDate },
    )
    const sessions = calendar.providerSessions.map((day) => ({
      sessionDate: day.date,
      openAt: day.regularOpenAt,
      closeAt: day.regularCloseAt,
    }))
    if (
      (yield* canonicalHashV1Result(calendar)) !== registration.calendar.sourceHash ||
      (yield* canonicalHashV1Result(sessions)) !== (yield* canonicalHashV1Result(registration.calendar.sessions))
    )
      return yield* fail('Frozen replay calendar differs from the registered sessions')
    const assets = []
    for (const raw of input.backtest.assets) {
      const normalized = yield* normalizeAssetResult(raw, raw.symbol, input.backtest.assetObservationAt)
      // The original asset wire predates the three instrument precision fields. Original whole-share rules stay in the pinned engine.
      const {
        minimumQuantityAtoms: _minimum,
        quantityIncrementAtoms: _quantity,
        priceIncrementAtoms: _price,
        normalizedResponseHash: _hash,
        observedAt,
        ...material
      } = normalized
      assets.push({ ...material, observedAt, normalizedResponseHash: yield* canonicalHashV1Result(material) })
    }
    if (
      new Set(assets.map((asset) => asset.symbol)).size !== protocol.universe.length ||
      assets.length !== protocol.universe.length ||
      assets.some((asset) => !protocol.universe.includes(asset.symbol))
    )
      return yield* fail('Frozen replay assets omit or substitute original instruments')
    const engineRunId = yield* canonicalHashV1Result({ ...input.backtest, assets, sourceReceiptHash: captureHash })
    return { input, protocol, stress, definition, engineRunId, runId: yield* canonicalHashV1Result(input), captureHash }
  })
