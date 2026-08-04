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
    horizons: [126, 252],
    signal: {
      ...defaultProtocolDocument.signal,
      minimumPositiveHorizons: 2,
    },
  }),
)

const definition: RiskBalancedTrendStrategyDefinition = {
  ...makeRiskBalancedTrendDefinition(protocol),
  name: 'candidate-23-long-horizon-trend-consensus',
}

/** Result-blind long-horizon consensus using the existing verified strategy core and risk bounds. */
export const strategyApplication = makeRiskBalancedTrendApplication(protocol, definition)
