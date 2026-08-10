import { Data, Effect, Result, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'
import { defaultExecutionModel } from './strategy/execution-model/model'
import { ExecutionModelV1Schema, ExecutionModelV2Schema } from './execution-model-contract'
import { canonicalHashV1, sha256 } from './hash'
import {
  IsoDateSchema,
  PositiveFiniteSchema as PositiveFinite,
  PositiveIntegerSchema as PositiveInteger,
  PositiveMicrosSchema as PositiveMicros,
  Sha256Schema,
  SymbolSchema as SymbolName,
  UniverseIdSchema,
  UnitIntervalSchema as UnitInterval,
  strictParseOptions as StrictParseOptions,
} from './schemas'

export const DIRECT_VOLATILITY_WINDOW = 63

const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const EconomicThresholdsSchema = Schema.Struct({
  minimumObservations: PositiveInteger,
  minimumAnnualizedReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
  minimumSharpeImprovement: Schema.Finite,
  maximumDrawdown: UnitInterval,
  maximumAnnualTurnover: PositiveFinite,
  requirePositiveDoubleCostReturn: Schema.Boolean,
})
export type EconomicThresholds = typeof EconomicThresholdsSchema.Type

export {
  ExecutionModelV1Schema,
  ExecutionModelV2Schema,
  ExecutionModelSchema,
  type ExecutionModel,
} from './execution-model-contract'

const defaultEconomicThresholds = {
  minimumObservations: 504,
  minimumAnnualizedReturn: 0,
  minimumSharpeImprovement: 0,
  maximumDrawdown: 0.35,
  maximumAnnualTurnover: 12,
  requirePositiveDoubleCostReturn: true,
} as const

const universeContract = {
  id: 'cross-asset-taa-v1',
  symbolHash: 'c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8',
  symbols: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
  historyStart: '2016-01-04',
  evaluationStart: '2017-01-03',
} as const

const ProtocolCommon = {
  universeId: UniverseIdSchema,
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  historyStart: IsoDateSchema,
  evaluationStart: IsoDateSchema,
  horizons: Schema.Array(PositiveInteger).check(Schema.isMinLength(1)),
  volatilityWindow: PositiveInteger,
  rebalance: Schema.Literal('month-end'),
  positionPolicy: Schema.Literal('long-or-cash'),
  maximumSymbolWeight: PositiveUnitInterval,
  maximumPortfolioVolatility: PositiveUnitInterval,
  directVolatilityTarget: PositiveUnitInterval,
  initialCapitalMicros: PositiveMicros,
  thresholds: EconomicThresholdsSchema,
} as const

const ProtocolV2Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v2'),
  ...ProtocolCommon,
  executionModel: ExecutionModelV1Schema,
})

const ProtocolV3Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v3'),
  ...ProtocolCommon,
  executionModel: ExecutionModelV2Schema,
})

const ProtocolV4Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v4'),
  ...ProtocolCommon,
  signal: Schema.Struct({
    aggregation: Schema.Literal('clipped-median-consensus'),
    normalizedTrendCap: PositiveFinite,
    minimumPositiveHorizons: PositiveInteger,
    allocation: Schema.Literal('conviction-inverse-volatility'),
  }),
  executionModel: ExecutionModelV2Schema,
})

const protocolIssues = (
  parameters: typeof ProtocolV2Base.Type | typeof ProtocolV3Base.Type | typeof ProtocolV4Base.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const sortedUniverse = [...new Set(parameters.universe)].sort()
  if (sortedUniverse.length !== parameters.universe.length) {
    issues.push({ path: ['universe'], issue: 'must not contain duplicate symbols' })
  } else if (sortedUniverse.some((symbol, index) => symbol !== parameters.universe[index])) {
    issues.push({ path: ['universe'], issue: 'must be sorted in canonical order' })
  }
  if (parameters.universeSymbolHash !== sha256(parameters.universe.join(','))) {
    issues.push({ path: ['universeSymbolHash'], issue: 'must match the canonical universe' })
  }
  if (
    parameters.universeSymbolHash !== universeContract.symbolHash ||
    parameters.universe.join(',') !== universeContract.symbols.join(',') ||
    parameters.historyStart !== universeContract.historyStart ||
    parameters.evaluationStart !== universeContract.evaluationStart
  ) {
    issues.push({ path: ['universeId'], issue: 'must identify its exact source-controlled universe contract' })
  }
  if (parameters.evaluationStart <= parameters.historyStart) {
    issues.push({ path: ['evaluationStart'], issue: 'must follow historyStart' })
  }
  for (let index = 1; index < parameters.horizons.length; index += 1) {
    const previous = parameters.horizons[index - 1]
    const current = parameters.horizons[index]
    if (previous === undefined || current === undefined || current <= previous) {
      issues.push({ path: ['horizons', index], issue: 'must be unique and strictly increasing' })
      break
    }
  }
  if (parameters.volatilityWindow < 2) {
    issues.push({ path: ['volatilityWindow'], issue: 'must contain at least two returns for covariance' })
  }
  if (Math.max(parameters.volatilityWindow, ...parameters.horizons) < DIRECT_VOLATILITY_WINDOW) {
    issues.push({
      path: ['horizons'],
      issue: `must provide at least ${DIRECT_VOLATILITY_WINDOW} sessions for the direct-volatility benchmark`,
    })
  }
  if (
    parameters.schemaVersion === 'bayn.risk-balanced-trend.protocol.v4' &&
    parameters.signal.minimumPositiveHorizons > parameters.horizons.length
  ) {
    issues.push({
      path: ['signal', 'minimumPositiveHorizons'],
      issue: 'must not exceed the configured horizon count',
    })
  }
  return issues
}

export const ProtocolV2Schema = ProtocolV2Base.check(Schema.makeFilter(protocolIssues))
export const ProtocolV3Schema = ProtocolV3Base.check(Schema.makeFilter(protocolIssues))
export const ProtocolV4Schema = ProtocolV4Base.check(Schema.makeFilter(protocolIssues))
export const ProtocolSchema = Schema.Union([ProtocolV2Schema, ProtocolV3Schema, ProtocolV4Schema])
export type Protocol = typeof ProtocolSchema.Type
export type CausalProtocol = typeof ProtocolV4Schema.Type

export const defaultProtocolDocument = {
  schemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
  universeId: universeContract.id,
  universeSymbolHash: universeContract.symbolHash,
  universe: universeContract.symbols,
  historyStart: universeContract.historyStart,
  evaluationStart: universeContract.evaluationStart,
  horizons: [21, 63, 126, 252],
  volatilityWindow: 63,
  rebalance: 'month-end',
  positionPolicy: 'long-or-cash',
  maximumSymbolWeight: 0.35,
  maximumPortfolioVolatility: 0.1,
  directVolatilityTarget: 0.1,
  signal: {
    aggregation: 'clipped-median-consensus',
    normalizedTrendCap: 2,
    minimumPositiveHorizons: 3,
    allocation: 'conviction-inverse-volatility',
  },
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: defaultEconomicThresholds,
} as const

export class ProtocolDecodeError extends Data.TaggedError('ProtocolDecodeError')<{
  readonly document: 'causal-default' | 'protocol'
  readonly message: string
  readonly cause: Schema.SchemaError
}> {}

const decodeProtocolDocument = Schema.decodeUnknownResult(ProtocolSchema, StrictParseOptions)
const decodeCausalProtocolDocument = Schema.decodeUnknownResult(ProtocolV4Schema, StrictParseOptions)

export const decodeProtocol = (input: unknown): Result.Result<Protocol, ProtocolDecodeError> =>
  Result.mapError(
    decodeProtocolDocument(input),
    (cause) =>
      new ProtocolDecodeError({
        document: 'protocol',
        message: 'invalid risk-balanced trend parameters',
        cause,
      }),
  )

export const decodeDefaultProtocol = (): Result.Result<CausalProtocol, ProtocolDecodeError> =>
  Result.mapError(
    decodeCausalProtocolDocument(defaultProtocolDocument),
    (cause) =>
      new ProtocolDecodeError({
        document: 'causal-default',
        message: 'invalid default risk-balanced trend parameters',
        cause,
      }),
  )

const protocolOperationalBoundary = <A>(
  decoded: Result.Result<A, ProtocolDecodeError>,
): Effect.Effect<A, OperationalError> =>
  Effect.fromResult(decoded).pipe(
    Effect.mapError((error) => operationalError('strategy', 'parameters', error.message, error)),
  )

export const loadProtocol = (input: unknown): Effect.Effect<Protocol, OperationalError> =>
  protocolOperationalBoundary(decodeProtocol(input))

export const loadDefaultProtocol: Effect.Effect<CausalProtocol, OperationalError> =
  protocolOperationalBoundary(decodeDefaultProtocol())

export const hashParameters = (parameters: Protocol): string => canonicalHashV1(parameters)
