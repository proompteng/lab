import type { Result } from 'effect'

/** A concrete strategy closes this to its finite tagged decision-failure union. */
export interface StrategyDecisionFailure {
  readonly _tag: string
}

/** The common output consumed by later portfolio planning stages. */
export interface StrategyTargetPortfolio {
  readonly targetWeights: Readonly<Record<string, number>>
}

/** Inputs verified by the caller before a pure strategy decision is requested. */
export interface VerifiedStrategyContext<TMarket, TPortfolio> {
  readonly market: TMarket
  readonly portfolio: TPortfolio
}

/** Pure strategy identity and decision boundary shared by development and runtimes. */
export interface StrategyDefinition<
  TParameters,
  TMarket,
  TPortfolio,
  TTargetPortfolio extends StrategyTargetPortfolio,
  TFailure extends StrategyDecisionFailure,
> {
  readonly name: string
  readonly parameters: TParameters
  readonly decide: (context: VerifiedStrategyContext<TMarket, TPortfolio>) => Result.Result<TTargetPortfolio, TFailure>
}
