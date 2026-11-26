import { Schema } from 'effect'
import { IsoDateSchema, StrictNonEmptyStringSchema, SymbolSchema } from '../schemas'
import { IntradayMomentumTargetPortfolioSchema } from './intraday-momentum/model'
import { EntryAblationTargetSchema } from '../jev/entry-ablation'
import { JevEntryTargetSchema } from '../jev/decision'
import { JevExitTargetSchema } from '../jev/exit'
import { RepeatedMomentumTargetSchema } from './repeated-momentum/decision'
import { IntradayAlphaTargetSchema, type IntradayAlphaTarget } from './intraday-alpha/decision'
import { IntradayAlphaPhase } from './intraday-alpha/constants'
import type { RetainedJevEntryTarget, RetainedJevExitTarget } from '../jev/retained-jev-targets'
import type { RetainedJevAblationTarget, RetainedJevMomentumTarget } from '../jev/retained-jev-control-targets'
import { isShortExitPlan } from './funded-exit-plan'
import type { EquityShortEligibility } from '../execution/equity-short'

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
  IntradayAlphaTargetSchema,
  JevExitTargetSchema,
  IntradayMomentumTargetPortfolioSchema,
  FlatExecutionTargetSchema,
])

export type RuntimeStrategyDecision = typeof RuntimeStrategyDecisionSchema.Type
/** Read-only evidence may carry an exact retained target; the runtime schema above remains current-only. */
export type RecordedRuntimeStrategyDecision =
  | RuntimeStrategyDecision
  | RetainedJevEntryTarget
  | RetainedJevExitTarget
  | RetainedJevAblationTarget
  | RetainedJevMomentumTarget

export const runtimeDecisionMatchesStrategy = (
  decision: RecordedRuntimeStrategyDecision,
  strategyName: string,
): boolean => {
  switch (decision.schemaVersion) {
    case 'bayn.jev-entry-target.v7':
    case 'bayn.entry-ablation-target.v1':
    case 'bayn.repeated-momentum-target.v1':
    case 'bayn.intraday-alpha-target.v2':
    case 'bayn.jev-exit-target.v5':
      return strategyName === 'jev'
    case 'bayn.intraday-momentum.target.v3':
      return strategyName === 'intraday-momentum'
    case 'bayn.execution-flat-target.v1':
      return decision.strategyName === strategyName
  }
}

export const isFlatExecutionTarget = <Decision extends RecordedRuntimeStrategyDecision | undefined>(
  decision: Decision,
): decision is Extract<
  Decision,
  { readonly schemaVersion: 'bayn.execution-flat-target.v1' | 'bayn.jev-exit-target.v5' }
> =>
  decision?.schemaVersion === 'bayn.execution-flat-target.v1' || decision?.schemaVersion === 'bayn.jev-exit-target.v5'

export type ChartEntryTarget = Extract<
  RuntimeStrategyDecision,
  {
    readonly schemaVersion: 'bayn.jev-entry-target.v7' | 'bayn.entry-ablation-target.v1'
  }
>

export const isChartEntryTarget = <Decision extends RecordedRuntimeStrategyDecision | undefined>(
  decision: Decision,
): decision is Extract<
  Decision,
  { readonly schemaVersion: 'bayn.jev-entry-target.v7' | 'bayn.entry-ablation-target.v1' }
> =>
  decision?.schemaVersion === 'bayn.jev-entry-target.v7' || decision?.schemaVersion === 'bayn.entry-ablation-target.v1'

export type ProtectedEntryTarget =
  | ChartEntryTarget
  | typeof RepeatedMomentumTargetSchema.Type
  | typeof IntradayAlphaTargetSchema.Type
export type RecordedProtectedEntryTarget =
  | ProtectedEntryTarget
  | RetainedJevEntryTarget
  | RetainedJevAblationTarget
  | RetainedJevMomentumTarget

export const isProtectedEntryTarget = <Decision extends RecordedRuntimeStrategyDecision | undefined>(
  decision: Decision,
): decision is Extract<
  Decision,
  {
    readonly schemaVersion:
      | 'bayn.jev-entry-target.v7'
      | 'bayn.entry-ablation-target.v1'
      | 'bayn.repeated-momentum-target.v1'
      | 'bayn.intraday-alpha-target.v2'
  }
> =>
  isChartEntryTarget(decision) ||
  decision?.schemaVersion === 'bayn.repeated-momentum-target.v1' ||
  decision?.schemaVersion === 'bayn.intraday-alpha-target.v2'

export const isMiddayAlphaTarget = (
  decision: RecordedRuntimeStrategyDecision | undefined,
): decision is IntradayAlphaTarget & { readonly phase: IntradayAlphaPhase.MiddayReversion } =>
  decision?.schemaVersion === 'bayn.intraday-alpha-target.v2' && decision.phase === IntradayAlphaPhase.MiddayReversion

export const isBrokerManagedAlphaTarget = (
  decision: RecordedRuntimeStrategyDecision | undefined,
): decision is IntradayAlphaTarget & {
  readonly phase: IntradayAlphaPhase.MiddayReversion | IntradayAlphaPhase.NoiseAreaTrend
} =>
  decision?.schemaVersion === 'bayn.intraday-alpha-target.v2' &&
  (decision.phase === IntradayAlphaPhase.MiddayReversion || decision.phase === IntradayAlphaPhase.NoiseAreaTrend)

export const protectedEntryBuyPriceCeilings = (
  decision: RecordedRuntimeStrategyDecision | undefined,
): Readonly<Record<string, bigint>> =>
  isProtectedEntryTarget(decision)
    ? Object.fromEntries(
        Object.entries(decision.exitPolicy.plans)
          .filter(([, plan]) => !isShortExitPlan(plan))
          .map(([symbol, plan]) => [
            symbol,
            BigInt('maximumEntryPriceMicros' in plan.levels ? plan.levels.maximumEntryPriceMicros : '0'),
          ]),
      )
    : {}

export const protectedEntrySellPriceFloors = (
  decision: RecordedRuntimeStrategyDecision | undefined,
): Readonly<Record<string, bigint>> =>
  isProtectedEntryTarget(decision)
    ? Object.fromEntries(
        Object.entries(decision.exitPolicy.plans).flatMap(([symbol, plan]) =>
          isShortExitPlan(plan) ? [[symbol, BigInt(plan.levels.minimumEntryPriceMicros)]] : [],
        ),
      )
    : {}

export const protectedEntryShortEligibility = (
  decision: RecordedRuntimeStrategyDecision | undefined,
): Readonly<Record<string, EquityShortEligibility>> => {
  if (!isChartEntryTarget(decision) && decision?.schemaVersion !== 'bayn.intraday-alpha-target.v2') return {}
  const observation = decision.evidence.observation
  if (!('equityShortEligibility' in observation) || observation.equityShortEligibility === undefined) return {}
  return Object.fromEntries(
    Object.entries(decision.exitPolicy.plans).flatMap(([symbol, plan]) => {
      const eligibility = observation.equityShortEligibility?.[symbol]
      return isShortExitPlan(plan) && eligibility !== undefined ? [[symbol, eligibility]] : []
    }),
  )
}

export const protectedEntryExpiresAtMs = (target: RecordedProtectedEntryTarget): number =>
  isChartEntryTarget(target)
    ? Date.parse(target.evidence.batchPlan.expiresAt)
    : Date.parse(target.evidence.observation.observedAt) + target.policy.sharedProtocol.inferenceValidityMs
