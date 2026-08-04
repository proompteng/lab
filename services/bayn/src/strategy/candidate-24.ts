import { Result } from 'effect'

import { decodeProtocol, defaultProtocolDocument } from '../protocol'
import {
  makeRiskBalancedTrendApplication,
  makeRiskBalancedTrendDefinition,
  type RiskBalancedTrendStrategyDefinition,
} from './risk-balanced-trend'

const protocol = Result.getOrThrow(
  decodeProtocol({
    ...defaultProtocolDocument,
    horizons: [252],
    signal: {
      ...defaultProtocolDocument.signal,
      minimumPositiveHorizons: 1,
    },
  }),
)

const definition: RiskBalancedTrendStrategyDefinition = {
  ...makeRiskBalancedTrendDefinition(protocol),
  name: 'candidate-24-twelve-month-time-series-momentum',
}

/** Result-blind 12-month time-series momentum using the verified strategy core and unchanged risk bounds. */
export const strategyApplication = makeRiskBalancedTrendApplication(protocol, definition)
