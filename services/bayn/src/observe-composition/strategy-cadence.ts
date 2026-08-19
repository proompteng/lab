import { isEverySessionCycleCadence, type CycleCadence } from '../cycle/runner'
import { strategyApplication, type StrategyRuntimeInput } from '../strategy'

/** An every-session execution grant may open positions only for a strategy that closes in the same session. */
export const strategyAllowsMutationCadence = (
  strategy: StrategyRuntimeInput,
  cadence: CycleCadence | undefined,
): boolean =>
  !isEverySessionCycleCadence(cadence) || strategyApplication(strategy).definition.holdingPeriod === 'INTRADAY'
