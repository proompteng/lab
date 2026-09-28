import { Schema } from 'effect'
import { IsoDateSchema, StrictNonEmptyStringSchema, SymbolSchema } from '../schemas'
import { IntradayMomentumTargetPortfolioSchema } from './intraday-momentum/model'
import { JevEntryTargetSchema } from '../jev/decision'
import { JevExitTargetSchema } from '../jev/exit'

const FlatExecutionTargetBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-flat-target.v1'),
  strategyName: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  targetWeights: Schema.Record(SymbolSchema, Schema.Literal(0)),
  symbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  reason: Schema.Literal('mandate-close'),
})

export const FlatExecutionTargetSchema = FlatExecutionTargetBase.check(
  Schema.makeFilter((target) => {
    const weightSymbols = Object.keys(target.targetWeights).sort()
    const declaredSymbols = [...target.symbols].sort()
    return weightSymbols.length === declaredSymbols.length &&
      weightSymbols.every((symbol, index) => symbol === declaredSymbols[index])
      ? []
      : [{ path: ['targetWeights'], issue: 'keys must exactly match the declared close symbols' }]
  }),
)

export const RuntimeStrategyDecisionSchema = Schema.Union([
  JevEntryTargetSchema,
  JevExitTargetSchema,
  IntradayMomentumTargetPortfolioSchema,
  FlatExecutionTargetSchema,
])

export type RuntimeStrategyDecision = typeof RuntimeStrategyDecisionSchema.Type

export const runtimeDecisionMatchesStrategy = (decision: RuntimeStrategyDecision, strategyName: string): boolean => {
  switch (decision.schemaVersion) {
    case 'bayn.jev-entry-target.v1':
    case 'bayn.jev-exit-target.v1':
      return strategyName === 'jev'
    case 'bayn.intraday-momentum.target.v3':
      return strategyName === 'intraday-momentum'
    case 'bayn.execution-flat-target.v1':
      return decision.strategyName === strategyName
  }
}

export const isFlatExecutionTarget = (
  decision: RuntimeStrategyDecision | undefined,
): decision is Extract<
  RuntimeStrategyDecision,
  { readonly schemaVersion: 'bayn.execution-flat-target.v1' | 'bayn.jev-exit-target.v1' }
> =>
  decision?.schemaVersion === 'bayn.execution-flat-target.v1' || decision?.schemaVersion === 'bayn.jev-exit-target.v1'

export const runtimeDecisionSessionDate = (decision: RuntimeStrategyDecision): string => decision.sessionDate
