import { Schema } from 'effect'
import { IsoDateSchema, StrictNonEmptyStringSchema, SymbolSchema } from '../schemas'
import { IntradayMomentumTargetPortfolioSchema } from './intraday-momentum/model'
import { EntryAblationTargetSchema } from '../jev/entry-ablation'
import { JevEntryTargetSchema } from '../jev/decision'
import { JevExitTargetSchema } from '../jev/exit'
import { RepeatedMomentumTargetSchema } from './repeated-momentum/decision'

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
  EntryAblationTargetSchema,
  RepeatedMomentumTargetSchema,
  JevExitTargetSchema,
  IntradayMomentumTargetPortfolioSchema,
  FlatExecutionTargetSchema,
])

export type RuntimeStrategyDecision = typeof RuntimeStrategyDecisionSchema.Type

export const runtimeDecisionMatchesStrategy = (decision: RuntimeStrategyDecision, strategyName: string): boolean => {
  switch (decision.schemaVersion) {
    case 'bayn.jev-entry-target.v7':
    case 'bayn.entry-ablation-target.v1':
    case 'bayn.repeated-momentum-target.v1':
    case 'bayn.jev-exit-target.v5':
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
  { readonly schemaVersion: 'bayn.execution-flat-target.v1' | 'bayn.jev-exit-target.v5' }
> =>
  decision?.schemaVersion === 'bayn.execution-flat-target.v1' || decision?.schemaVersion === 'bayn.jev-exit-target.v5'

export type ChartEntryTarget = Extract<
  RuntimeStrategyDecision,
  {
    readonly schemaVersion: 'bayn.jev-entry-target.v7' | 'bayn.entry-ablation-target.v1'
  }
>

export const isChartEntryTarget = (decision: RuntimeStrategyDecision | undefined): decision is ChartEntryTarget =>
  decision?.schemaVersion === 'bayn.jev-entry-target.v7' || decision?.schemaVersion === 'bayn.entry-ablation-target.v1'

export type ProtectedEntryTarget = ChartEntryTarget | typeof RepeatedMomentumTargetSchema.Type

export const isProtectedEntryTarget = (
  decision: RuntimeStrategyDecision | undefined,
): decision is ProtectedEntryTarget =>
  isChartEntryTarget(decision) || decision?.schemaVersion === 'bayn.repeated-momentum-target.v1'

export const protectedEntryExpiresAtMs = (target: ProtectedEntryTarget): number =>
  isChartEntryTarget(target)
    ? Date.parse(target.evidence.batchPlan.expiresAt)
    : Date.parse(target.evidence.observation.observedAt) + target.policy.sharedProtocol.inferenceValidityMs
