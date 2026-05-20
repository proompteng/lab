import type {
  ControlPlaneControllerWitnessQuorum,
  DependencyQuorumStatus,
  EmpiricalServicesStatus,
  FailureDomainLeaseSet,
  ReconciledActionClock,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import {
  buildControlPlaneMaterialActionArtifacts,
  type RepairScheduleAttemptResolver,
} from '~/server/control-plane-material-action-artifacts'
import type { ExecutionTrustSnapshot } from '~/server/control-plane-execution-trust'
import type {
  FailureDomainKubernetesEvidence,
  FailureDomainRouteProbe,
} from '~/server/control-plane-failure-domain-leases'
import { buildNegativeEvidenceRouterStatus } from '~/server/control-plane-negative-evidence-router'
import type { ProjectionForeclosureEvidence } from '~/server/control-plane-projection-foreclosure-notary'
import type { RuntimeAdmissionSnapshot } from '~/server/control-plane-runtime-admission'
import {
  buildSourceRolloutTruthExchange,
  type SourceRolloutTruthEnvironment,
} from '~/server/control-plane-source-rollout-truth-exchange'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceResolution } from '~/server/control-plane-torghut-consumer-evidence'

export type BuildControlPlaneMaterialStatusInput = {
  now: Date
  namespace: string
  service: string
  workflows: WorkflowsReliabilityStatus
  watchReliability: ControlPlaneWatchReliability
  agentRunIngestion: AgentRunIngestionStatus
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  dependencyQuorum: DependencyQuorumStatus
  failureDomainLeases: FailureDomainLeaseSet
  empiricalServices: EmpiricalServicesStatus
  executionTrust: ExecutionTrustSnapshot
  runtimeAdmission: RuntimeAdmissionSnapshot
  controllerWitness: ControlPlaneControllerWitnessQuorum
  torghutConsumerEvidence: TorghutConsumerEvidenceResolution
  sourceRolloutTruthEnvironment: SourceRolloutTruthEnvironment
  failureDomainKubernetesEvidence: FailureDomainKubernetesEvidence
  routeProbe: FailureDomainRouteProbe
  reconciledActionClocks: ReconciledActionClock[]
  projectionForeclosureEvidence: ProjectionForeclosureEvidence
  resolveRepairScheduleAttempts?: RepairScheduleAttemptResolver
}

export const buildControlPlaneMaterialStatus = async (input: BuildControlPlaneMaterialStatusInput) => {
  const negativeEvidenceRouter = buildNegativeEvidenceRouterStatus({
    now: input.now,
    namespace: input.namespace,
    service: input.service,
    workflows: input.workflows,
    watchReliability: input.watchReliability,
    agentRunIngestion: input.agentRunIngestion,
    database: input.database,
    rolloutHealth: input.rolloutHealth,
    dependencyQuorum: input.dependencyQuorum,
    failureDomainLeases: input.failureDomainLeases,
    empiricalServices: input.empiricalServices,
    executionTrust: input.executionTrust.executionTrust,
    runtimeKits: input.runtimeAdmission.runtimeKits,
    controllerWitness: input.controllerWitness,
    torghut: input.torghutConsumerEvidence.negativeEvidence,
  })
  const sourceRolloutTruthExchange = buildSourceRolloutTruthExchange({
    now: input.now,
    namespace: input.namespace,
    service: input.service,
    sourceHeadSha: input.sourceRolloutTruthEnvironment.sourceHeadSha,
    gitopsRevision: input.sourceRolloutTruthEnvironment.gitopsRevision,
    runtimeKits: input.runtimeAdmission.runtimeKits,
    kubernetesEvidence: input.failureDomainKubernetesEvidence,
    controllerWitness: input.controllerWitness,
    routeProbe: input.routeProbe,
    database: input.database,
    watchReliability: input.watchReliability,
    rolloutHealth: input.rolloutHealth,
    actionSloBudgets: negativeEvidenceRouter.budgets,
    torghutActionSloBudgets: negativeEvidenceRouter.torghutBudgets,
  })
  const materialArtifacts = await buildControlPlaneMaterialActionArtifacts({
    now: input.now,
    namespace: input.namespace,
    service: input.service,
    agentRunIngestion: input.agentRunIngestion,
    admissionPassports: input.runtimeAdmission.admissionPassports,
    dependencyQuorum: input.dependencyQuorum,
    workflows: input.workflows,
    negativeEvidenceRouter,
    reconciledActionClocks: input.reconciledActionClocks,
    rolloutHealth: input.rolloutHealth,
    controllerWitness: input.controllerWitness,
    database: input.database,
    watchReliability: input.watchReliability,
    empiricalServices: input.empiricalServices,
    sourceRolloutTruthExchange,
    failureDomainLeases: input.failureDomainLeases,
    executionTrust: input.executionTrust,
    routeProbe: input.routeProbe,
    torghutConsumerEvidence: input.torghutConsumerEvidence.status,
    projectionForeclosureEvidence: input.projectionForeclosureEvidence,
    resolveRepairScheduleAttempts: input.resolveRepairScheduleAttempts,
  })

  return { negativeEvidenceRouter, sourceRolloutTruthExchange, materialArtifacts }
}
