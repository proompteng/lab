import { configureAgentsControllerRuntime } from '@proompteng/agents/server/agents-controller'
import { configureAgentsMetricsSink } from '@proompteng/agents/server/metrics'

import { resolveBooleanFeatureToggle } from '~/server/feature-flags'
import {
  recordAgentConcurrency,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordAgentRunResyncAdoptions,
  recordAgentRunUntouchedBacklog,
  recordAgentRunUntouchedOldestAgeSeconds,
  recordReconcileDurationMs,
} from '~/server/metrics'
import { createPrimitivesStore } from '~/server/primitives-store'
import { maybeFinalizeWhitepaperRun } from './whitepaper-finalize'

configureAgentsControllerRuntime({
  createPrimitivesStore,
  onAgentRunTerminalStatus: maybeFinalizeWhitepaperRun,
  resolveBooleanFeatureToggle,
})

configureAgentsMetricsSink({
  recordAgentConcurrency,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordAgentRunResyncAdoptions,
  recordAgentRunUntouchedBacklog,
  recordAgentRunUntouchedOldestAgeSeconds,
  recordReconcileDurationMs,
})

export * from '@proompteng/agents/server/agents-controller'
