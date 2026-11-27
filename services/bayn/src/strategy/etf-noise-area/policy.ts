import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { strictParseOptions } from '../../schemas'

export const liveEtfNoiseAreaSymbols = Object.freeze(['QQQ', 'SMH'] as const)
export const expandedEtfNoiseAreaSymbols = Object.freeze(['SPY', 'QQQ', 'IWM', 'SMH', 'TLT', 'GLD'] as const)

const rules = {
  schemaVersion: 'bayn.etf-noise-area-policy.v1',
  lookbackSessions: 14,
  bandMultiplier: 1.2,
  checkpointMinutes: 30,
  lastCheckpointMinuteFromOpen: 330,
  minimumEntryMinutesBeforeClose: 30,
  maxEntriesPerSymbolPerSession: 1,
  exitRule: 'oppositeBand',
  protectiveStopAtrMultiple: 1.5,
  flattenMinutesBeforeRegularClose: 2,
  entryLimitSlippageBps: 25,
  stopLimitAtrMultiple: 0.25,
  minimumStopLimitCollarBps: 50,
  maximumStopLimitCollarBps: 150,
  maximumGrossUsd: 180_000,
} as const

export const EtfNoiseAreaPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal(rules.schemaVersion),
  symbols: Schema.Union([
    Schema.Tuple([Schema.Literal(liveEtfNoiseAreaSymbols[0]), Schema.Literal(liveEtfNoiseAreaSymbols[1])]),
    Schema.Tuple([
      Schema.Literal(expandedEtfNoiseAreaSymbols[0]),
      Schema.Literal(expandedEtfNoiseAreaSymbols[1]),
      Schema.Literal(expandedEtfNoiseAreaSymbols[2]),
      Schema.Literal(expandedEtfNoiseAreaSymbols[3]),
      Schema.Literal(expandedEtfNoiseAreaSymbols[4]),
      Schema.Literal(expandedEtfNoiseAreaSymbols[5]),
    ]),
  ]),
  lookbackSessions: Schema.Literal(rules.lookbackSessions),
  bandMultiplier: Schema.Literal(rules.bandMultiplier),
  checkpointMinutes: Schema.Literal(rules.checkpointMinutes),
  lastCheckpointMinuteFromOpen: Schema.Literal(rules.lastCheckpointMinuteFromOpen),
  minimumEntryMinutesBeforeClose: Schema.Literal(rules.minimumEntryMinutesBeforeClose),
  maxEntriesPerSymbolPerSession: Schema.Literal(rules.maxEntriesPerSymbolPerSession),
  exitRule: Schema.Literal(rules.exitRule),
  protectiveStopAtrMultiple: Schema.Literal(rules.protectiveStopAtrMultiple),
  flattenMinutesBeforeRegularClose: Schema.Literal(rules.flattenMinutesBeforeRegularClose),
  entryLimitSlippageBps: Schema.Literal(rules.entryLimitSlippageBps),
  stopLimitAtrMultiple: Schema.Literal(rules.stopLimitAtrMultiple),
  minimumStopLimitCollarBps: Schema.Literal(rules.minimumStopLimitCollarBps),
  maximumStopLimitCollarBps: Schema.Literal(rules.maximumStopLimitCollarBps),
  maximumGrossUsd: Schema.Literal(rules.maximumGrossUsd),
  sizing: Schema.Literals(['equalWeight', 'inverseVolatility']),
})

export type EtfNoiseAreaPolicy = typeof EtfNoiseAreaPolicySchema.Type
export type EtfNoiseAreaSymbol = EtfNoiseAreaPolicy['symbols'][number]

export const decodeEtfNoiseAreaPolicy = (input: unknown) =>
  Schema.decodeUnknownResult(
    EtfNoiseAreaPolicySchema,
    strictParseOptions,
  )(input).pipe(
    Result.map((policy) => {
      Object.freeze(policy.symbols)
      return Object.freeze(policy)
    }),
  )

export const defaultEtfNoiseAreaPolicy: EtfNoiseAreaPolicy = Object.freeze({
  ...rules,
  symbols: liveEtfNoiseAreaSymbols,
  sizing: 'equalWeight',
})

export const expandedEtfNoiseAreaPolicy: EtfNoiseAreaPolicy = Object.freeze({
  ...defaultEtfNoiseAreaPolicy,
  symbols: expandedEtfNoiseAreaSymbols,
})

export const etfNoiseAreaPolicyHash = (policy: EtfNoiseAreaPolicy) => canonicalHashV1Result(policy)
