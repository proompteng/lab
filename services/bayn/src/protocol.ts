import { Effect, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import type { TsmomProtocol } from './types'

import protocolDocument from '../protocols/tsmom-v1.json' with { type: 'json' }

const StrictParseOptions = { onExcessProperty: 'error' } as const
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const SymbolName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
const PositiveMicros = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))

const TsmomProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.tsmom.protocol.v1'),
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  lookbacks: Schema.Array(PositiveInteger).check(Schema.isMinLength(1)),
  rebalance: Schema.Literal('month-end'),
  execution: Schema.Literal('next-session-open'),
  positionPolicy: Schema.Literal('long-or-cash'),
  directVolatilityTarget: PositiveUnitInterval,
  initialCapitalMicros: PositiveMicros,
  transactionCostBps: NonNegativeFinite.check(Schema.isLessThanOrEqualTo(10_000)),
  thresholds: Schema.Struct({
    minimumObservations: PositiveInteger,
    minimumAnnualizedReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
    minimumSharpeImprovement: Schema.Finite,
    maximumDrawdown: UnitInterval,
    maximumAnnualTurnover: PositiveFinite,
    requirePositiveDoubleCostReturn: Schema.Boolean,
  }),
})

export const TsmomProtocolSchema = TsmomProtocolBase.check(
  Schema.makeFilter((parameters: typeof TsmomProtocolBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    const sortedUniverse = [...new Set(parameters.universe)].sort()
    if (sortedUniverse.length !== parameters.universe.length) {
      issues.push({ path: ['universe'], issue: 'must not contain duplicate symbols' })
    } else if (sortedUniverse.some((symbol, index) => symbol !== parameters.universe[index])) {
      issues.push({ path: ['universe'], issue: 'must be sorted in canonical order' })
    }
    for (let index = 1; index < parameters.lookbacks.length; index += 1) {
      if (parameters.lookbacks[index] <= parameters.lookbacks[index - 1]) {
        issues.push({ path: ['lookbacks', index], issue: 'must be unique and strictly increasing' })
        break
      }
    }
    return issues
  }),
)

export const defaultProtocolDocument = protocolDocument

export const loadTsmomProtocol = (input: unknown): Effect.Effect<TsmomProtocol, OperationalError> =>
  Schema.decodeUnknownEffect(
    TsmomProtocolSchema,
    StrictParseOptions,
  )(input).pipe(
    Effect.mapError((cause) => operationalError('strategy', 'parameters', 'invalid TSMOM parameters', cause)),
  )

export const loadDefaultProtocol = loadTsmomProtocol(defaultProtocolDocument)

export const hashTsmomParameters = (parameters: TsmomProtocol): string => canonicalHashV1(parameters)
