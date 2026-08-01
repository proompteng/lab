import { Effect } from 'effect'

import { loadApplicationPlan } from './application-plan'
import { runApplicationPlan } from './composition'

export { loadApplicationPlan }
export {
  ApplicationPlatformLive,
  AutonomousApplicationResourcesLive,
  BrokerlessApplicationResourcesLive,
  BrokerSessionResourceLive,
  ClickHouseClientResourceLive,
  CycleObservabilityResourceLive,
  CycleStoreResourceLive,
  EvidenceStoreResourceLive,
  ExecutionCandidateDiscoveryResourcesLive,
  ExecutionPrepareResourcesLive,
  ExecutionStoreResourceLive,
  executionPrepareBoundaryError,
  JournalResourceLive,
  MarketDataResourceLive,
  PostgresClientResourceLive,
  runApplicationPlan,
  validateExecutionPreparePlan,
  WriterFenceResourceLive,
} from './composition'
export {
  decodeFreshBrokerPrice,
  latestQuoteUrl,
  makeFreshBrokerPriceReader,
  type AlpacaFreshBrokerQuote,
  type LatestQuoteDecodeFailure,
} from './broker/alpaca/http'

export const program = loadApplicationPlan.pipe(Effect.flatMap(runApplicationPlan), Effect.scoped)
