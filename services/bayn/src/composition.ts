import { Effect, Match, pipe } from 'effect'

import { runApplication, type ApplicationPlan, type ApplicationPlanFor } from './app'
import { runAutonomousService } from './composition/autonomous-runtime'
import { runExecutionCandidateDiscovery, runExecutionPreparePlan } from './composition/execution-prepare'
import {
  AutonomousApplicationResourcesLive,
  BrokerlessApplicationResourcesLive,
  ExecutionCandidateDiscoveryResourcesLive,
  applicationDependencies,
} from './composition/resources'

export {
  activatePreparedQualifiedCapitalGeneration,
  capitalReceiptFinalizationWindowOpen,
  closedCycleReceiptEmissionAllowed,
  decideExecutionLifecycleMaintenance,
  finalizeExecutionEpisode,
  prepareOrRecoverQualifiedCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readCompletedExecutionLifecycle,
  recoverCapitalActivationGeneration,
  refreshResearchCapitalActivationReconciliation,
  restrictExpiredCapitalActivation,
  runExecutionLifecycleMaintenance,
  type CompletedExecutionLifecycle,
  type ExecutionLifecycleMaintenanceDecision,
} from './composition/capital-activation'
export {
  executionPrepareBoundaryError,
  prepareExecutionPreparePlan,
  runExecutionPreparePlan,
  validateExecutionPreparePlan,
} from './composition/execution-prepare'
export { observeCycleGenerationHash, runRestateLifecycleWithReconciliationGuardian } from './composition/lifecycle'
export {
  ApplicationPlatformLive,
  AutonomousApplicationResourcesLive,
  AutonomousRuntimeResourcesLive,
  BrokerlessApplicationResourcesLive,
  BrokerSessionResourceLive,
  ClickHouseClientResourceLive,
  CycleObservabilityResourceLive,
  CycleStoreResourceLive,
  EvidenceStoreResourceLive,
  ExecutionCandidateDiscoveryResourcesLive,
  ExecutionPrepareExecutionResourcesLive,
  ExecutionPrepareResourcesLive,
  ExecutionPrepareValidationResourcesLive,
  ExecutionStoreResourceLive,
  JournalResourceLive,
  MarketDataResourceLive,
  PostgresClientResourceLive,
  QualifiedCapitalActivationStoreLive,
  WriterFenceResourceLive,
} from './composition/resources'

const runBrokerlessService = (plan: ApplicationPlanFor<'BrokerlessService'>) =>
  applicationDependencies.pipe(
    Effect.flatMap((dependencies) =>
      runApplication<never, never>(plan.config, plan.strategy, dependencies, { _tag: 'Brokerless' }),
    ),
  )

export const runApplicationPlan = pipe(
  Match.type<ApplicationPlan>(),
  Match.tag('BrokerlessService', (plan) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runBrokerlessService(plan).pipe(Effect.provide(BrokerlessApplicationResourcesLive(plan))),
  ),
  Match.tag('AutonomousService', (plan) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runAutonomousService(plan).pipe(Effect.provide(AutonomousApplicationResourcesLive(plan))),
  ),
  Match.tag('ExecutionCandidateDiscovery', (plan) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- application plan dispatch is the resource entry point
    runExecutionCandidateDiscovery(plan).pipe(Effect.provide(ExecutionCandidateDiscoveryResourcesLive(plan))),
  ),
  Match.tag('ExecutionPrepare', runExecutionPreparePlan),
  Match.exhaustive,
)
