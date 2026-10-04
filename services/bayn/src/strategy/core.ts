import type { Result } from 'effect'

import type { Protocol } from '../types'

/** A concrete strategy closes this to its finite tagged decision-failure union. */
export interface StrategyDecisionFailure {
  readonly _tag: string
}

/** The common output consumed by later portfolio planning stages. */
export interface TargetPortfolio {
  readonly targetWeights: Readonly<Record<string, number>>
}

/** Inputs verified by the caller before a pure strategy decision is requested. */
export interface VerifiedStrategyContext<TMarket> {
  readonly market: TMarket
}

/** Pure strategy identity and decision boundary shared by development and runtimes. */
export interface StrategyDefinition<
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio = TargetPortfolio,
  TParameters = Protocol,
> {
  readonly name: string
  /** Maximum lifetime of positions produced by this strategy. */
  readonly holdingPeriod: 'INTRADAY' | 'MULTI_SESSION'
  readonly parameters: TParameters
  readonly decide: (context: VerifiedStrategyContext<TMarket>) => Result.Result<TTarget, TFailure>
}
