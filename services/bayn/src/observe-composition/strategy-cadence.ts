import { isEverySessionCycleCadence, type CycleCadence } from '../cycle/runner'
import { strategyDefinition, type StrategyRuntimeInput } from '../strategy'

/** The strategy holding period is the sole source of truth for cycle frequency. */
export const strategyCycleCadence = (strategy: StrategyRuntimeInput): CycleCadence | undefined =>
  strategyDefinition(strategy).holdingPeriod === 'INTRADAY' ? 'EVERY_SESSION' : undefined

/** An every-session execution grant may open positions only for a strategy that closes in the same session. */
export const strategyAllowsMutationCadence = (
  strategy: StrategyRuntimeInput,
  cadence: CycleCadence | undefined,
): boolean => !isEverySessionCycleCadence(cadence) || strategyDefinition(strategy).holdingPeriod === 'INTRADAY'
