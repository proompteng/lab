import { Effect, Layer, Match, pipe } from 'effect'

import { runApplication, type ApplicationPlan, type ApplicationPlanFor } from './app'
import { runExecutionCandidateDiscovery, runExecutionPreparePlan } from './composition/execution-prepare'
import { runReadOnlyAutonomousStatusService } from './composition/read-only-status'
import {
  AutonomousStatusApplicationResourcesLive,
  BrokerlessApplicationResourcesLive,
  ExecutionCandidateDiscoveryResourcesLive,
  applicationDependencies,
} from './composition/resources'

export {
  activatePreparedQualifiedCapitalGeneration,
  prepareOrRecoverQualifiedCapitalActivation,
  prepareOrRecoverResearchCapitalActivation,
  readCompletedExecutionLifecycle,
  recoverCapitalActivationGeneration,
  refreshResearchCapitalActivationReconciliation,
  restrictExpiredCapitalActivation,
  type CompletedExecutionLifecycle,
} from './composition/capital-activation'
export {
  capitalReceiptFinalizationWindowOpen,
  closedCycleReceiptEmissionAllowed,
  decideExecutionLifecycleMaintenance,
  finalizeExecutionMandate,
  runExecutionLifecycleMaintenance,
  type ExecutionLifecycleMaintenanceDecision,
} from './composition/capital-lifecycle'
export {
  executionPrepareBoundaryError,
  prepareExecutionPreparePlan,
  runExecutionPreparePlan,
  validateExecutionPreparePlan,
} from './composition/execution-prepare'
export { observeCycleGenerationHash } from './composition/lifecycle'
export {
  ApplicationPlatformLive,
  AutonomousApplicationResourcesLive,
  AutonomousStatusApplicationResourcesLive,
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

const provideApplicationResources = <A, E, R, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  resources: Layer.Layer<R, E2, RIn>,
): Effect.Effect<A, E | E2, RIn> =>
  Effect.scoped(Layer.build(resources).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const runRoutedApplicationPlan = pipe(
  Match.type<RoutedApplicationPlan>(),
  Match.tag('BrokerlessService', ({ plan }) =>
    provideApplicationResources(runBrokerlessService(plan), BrokerlessApplicationResourcesLive(plan)),
  ),
  Match.tag('AutonomousReadOnlyStatus', ({ plan }) =>
    provideApplicationResources(
      runReadOnlyAutonomousStatusService(plan),
      AutonomousStatusApplicationResourcesLive(plan),
    ),
  ),
  Match.tag('ExecutionCandidateDiscovery', ({ plan }) =>
    provideApplicationResources(runExecutionCandidateDiscovery(plan), ExecutionCandidateDiscoveryResourcesLive(plan)),
  ),
  Match.tag('ExecutionPrepare', ({ plan }) => runExecutionPreparePlan(plan)),
  Match.exhaustive,
)

export type RoutedApplicationPlan =
  | { readonly _tag: 'BrokerlessService'; readonly plan: ApplicationPlanFor<'BrokerlessService'> }
  | { readonly _tag: 'AutonomousReadOnlyStatus'; readonly plan: ApplicationPlanFor<'AutonomousService'> }
  | {
      readonly _tag: 'ExecutionCandidateDiscovery'
      readonly plan: ApplicationPlanFor<'ExecutionCandidateDiscovery'>
    }
  | { readonly _tag: 'ExecutionPrepare'; readonly plan: ApplicationPlanFor<'ExecutionPrepare'> }

export const routeApplicationPlan = pipe(
  Match.type<ApplicationPlan>(),
  Match.tag('BrokerlessService', (plan): RoutedApplicationPlan => ({ _tag: 'BrokerlessService', plan })),
  Match.tag('AutonomousService', (plan): RoutedApplicationPlan => ({ _tag: 'AutonomousReadOnlyStatus', plan })),
  Match.tag(
    'ExecutionCandidateDiscovery',
    (plan): RoutedApplicationPlan => ({ _tag: 'ExecutionCandidateDiscovery', plan }),
  ),
  Match.tag('ExecutionPrepare', (plan): RoutedApplicationPlan => ({ _tag: 'ExecutionPrepare', plan })),
  Match.exhaustive,
)

export const runApplicationPlan = (plan: ApplicationPlan) => runRoutedApplicationPlan(routeApplicationPlan(plan))
