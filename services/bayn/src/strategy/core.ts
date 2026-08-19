import type { Result } from 'effect'

import type { RuntimeProvenance } from '../contracts'
import type { MarketDataInspection } from '../market-data'
import type { QualificationLock } from '../qualification'
import type { AlignedSession } from '../simulation'
import type { DailyBar, InputManifest, IsoDate } from '../types'
import type { Protocol } from '../types'

/** A concrete strategy closes this to its finite tagged decision-failure union. */
export interface StrategyDecisionFailure {
  readonly _tag: string
}

/** Closed failures for application-level projections that are shared by every adapter. */
export interface StrategyApplicationFailure {
  readonly _tag: 'StrategyApplicationFailure'
  readonly operation: 'manifest' | 'qualification-lock' | 'current-decision'
  readonly cause: unknown
}

/** The common output consumed by later portfolio planning stages. */
export interface TargetPortfolio {
  readonly targetWeights: Readonly<Record<string, number>>
}

/** Inputs verified by the caller before a pure strategy decision is requested. */
export interface VerifiedStrategyContext<TMarket> {
  readonly market: TMarket
}

/** Immutable identity of the reviewed source module that exports a candidate application. */
export interface ReviewedStrategySource {
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleSha256: string
}

/** Pure strategy identity and decision boundary shared by development and runtimes. */
export interface StrategyDefinition<
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio = TargetPortfolio,
> {
  readonly name: string
  /** Maximum lifetime of positions produced by this strategy. */
  readonly holdingPeriod: 'INTRADAY' | 'MULTI_SESSION'
  readonly parameters: Protocol
  readonly decide: (context: VerifiedStrategyContext<TMarket>) => Result.Result<TTarget, TFailure>
}

/**
 * The complete pure strategy boundary. The application owns both the decision function and the
 * verified projection from aligned market sessions into the decision context. Adapters may add
 * I/O around this boundary, but they must not provide a second projection or evaluator.
 */
export interface StrategyApplication<
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio = TargetPortfolio,
  TApplicationFailure extends StrategyApplicationFailure = StrategyApplicationFailure,
> {
  readonly definition: StrategyDefinition<TMarket, TFailure, TTarget>
  /** Candidate applications carry the exact reviewed module identity they execute. */
  readonly reviewedSource?: ReviewedStrategySource
  /** Deterministic flat target used for the terminal close of an evaluation or execution mandate. */
  readonly closeTarget: (target: TTarget) => TTarget
  readonly contextAtSignal: (
    sessions: readonly AlignedSession[],
    signalIndex: number,
  ) => Result.Result<VerifiedStrategyContext<TMarket>, TFailure>
  readonly parseManifest: (input: unknown) => Result.Result<InputManifest, TApplicationFailure>
  readonly prepareQualificationLock: (
    inspection: MarketDataInspection,
    provenance: RuntimeProvenance,
    priorTrialRunIds: readonly string[],
  ) => Result.Result<QualificationLock, TApplicationFailure>
  readonly evaluateCurrentDecision: (
    bars: readonly DailyBar[],
    inputManifest: InputManifest,
    cycleBinding: unknown,
  ) => Result.Result<CompiledStrategyDecision<TTarget>, TApplicationFailure>
}

export interface CompiledStrategyDecision<TTarget extends TargetPortfolio = TargetPortfolio> {
  readonly decision: TTarget
  readonly signalDate: IsoDate
  readonly priceMicros: Readonly<Record<string, string>>
}
