import type {
  AdmissionPassportStatus,
  ControlPlaneControllerWitnessQuorum,
  DependencyQuorumStatus,
  EmpiricalServicesStatus,
  FailureDomainLeaseSet,
  ReconciledActionClock,
  SourceRolloutTruthExchange,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { buildActionCustodyProjection } from '~/server/control-plane-action-custody'
import { buildClearanceMarketLedger, isClearanceMarketEnabled } from '~/server/control-plane-clearance-market'
import { buildMaterialActionActivationReceipts } from '~/server/control-plane-controller-witness'
import { buildDependencyVerdictExchange } from '~/server/control-plane-dependency-verdict'
import type { ExecutionTrustSnapshot } from '~/server/control-plane-execution-trust'
import { type FailureDomainRouteProbe } from '~/server/control-plane-failure-domain-leases'
import { buildMaterialActionVerdictEpoch } from '~/server/control-plane-material-action-verdict'
import { type NegativeEvidenceRouterResult } from '~/server/control-plane-negative-evidence-router'
import {
  buildRepairWarrantExchange,
  collectRepairScheduleAttempts,
  type RepairScheduleAttemptCollection,
} from '~/server/control-plane-repair-warrant-exchange'
import { buildRouteStabilityEscrow } from '~/server/control-plane-route-stability-escrow'
import { buildStageClearancePackets } from '~/server/control-plane-stage-clearance'
import { buildStageCreditLedger, isStageCreditLedgerEnabled } from '~/server/control-plane-stage-credit-ledger'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'
import { resolveWorkflowNamespaces } from '~/server/control-plane-workflows'
import type { KubeGateway } from '~/server/kube-gateway'

export type RepairScheduleAttemptResolver = (input: {
  now: Date
  namespaces: string[]
  kube: KubeGateway
}) => Promise<RepairScheduleAttemptCollection>

export type ControlPlaneMaterialActionArtifactsInput = {
  now: Date
  namespace: string
  service: string
  kube: KubeGateway
  agentRunIngestion: AgentRunIngestionStatus
  admissionPassports: AdmissionPassportStatus[]
  dependencyQuorum: DependencyQuorumStatus
  workflows: WorkflowsReliabilityStatus
  negativeEvidenceRouter: NegativeEvidenceRouterResult
  reconciledActionClocks: ReconciledActionClock[]
  rolloutHealth: ControlPlaneRolloutHealth
  controllerWitness: ControlPlaneControllerWitnessQuorum
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  empiricalServices: EmpiricalServicesStatus
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  failureDomainLeases: FailureDomainLeaseSet
  executionTrust: ExecutionTrustSnapshot
  routeProbe: FailureDomainRouteProbe
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  resolveRepairScheduleAttempts?: RepairScheduleAttemptResolver
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

export const buildControlPlaneMaterialActionArtifacts = async (input: ControlPlaneMaterialActionArtifactsInput) => {
  const repairScheduleAttempts = await (input.resolveRepairScheduleAttempts ?? collectRepairScheduleAttempts)({
    now: input.now,
    namespaces: resolveWorkflowNamespaces(input.namespace),
    kube: input.kube,
  }).catch(
    (error: unknown): RepairScheduleAttemptCollection => ({
      attempts: [],
      collectionErrors: [`repair schedule evidence collection failed: ${normalizeMessage(error)}`],
    }),
  )

  const repairWarrantExchange = buildRepairWarrantExchange({
    now: input.now,
    namespace: input.namespace,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    actionSloBudgets: input.negativeEvidenceRouter.budgets,
    torghutActionSloBudgets: input.negativeEvidenceRouter.torghutBudgets,
    watchReliability: input.watchReliability,
    rolloutHealth: input.rolloutHealth,
    scheduleAttempts: repairScheduleAttempts.attempts,
    scheduleCollectionErrors: repairScheduleAttempts.collectionErrors,
  })

  const materialActionVerdictEpoch = buildMaterialActionVerdictEpoch({
    now: input.now,
    namespace: input.namespace,
    dependencyQuorum: input.dependencyQuorum,
    negativeEvidenceRouter: input.negativeEvidenceRouter.router,
    actionSloBudgets: input.negativeEvidenceRouter.budgets,
    reconciledActionClocks: input.reconciledActionClocks,
    rolloutHealth: input.rolloutHealth,
    controllerWitness: input.controllerWitness,
    database: input.database,
    watchReliability: input.watchReliability,
    empiricalServices: input.empiricalServices,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    repairWarrantExchange,
  })

  const routeStabilityEscrow = buildRouteStabilityEscrow({
    now: input.now,
    namespace: input.namespace,
    service: input.service,
    routeProbe: input.routeProbe,
    database: input.database,
    rolloutHealth: input.rolloutHealth,
    watchReliability: input.watchReliability,
    controllerWitness: input.controllerWitness,
    materialActionVerdictEpoch,
  })

  const materialActionActivationReceipts = buildMaterialActionActivationReceipts({
    now: input.now,
    scope: `${input.namespace}/${input.service}`,
    controllerWitness: input.controllerWitness,
    router: input.negativeEvidenceRouter.router,
    budgets: input.negativeEvidenceRouter.budgets,
    materialActionVerdictEpoch,
    routeStabilityEscrow,
  })
  const actionCustodyProjection = buildActionCustodyProjection({
    now: input.now,
    namespace: input.namespace,
    workflows: input.workflows,
    controllerWitness: input.controllerWitness,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    routeStabilityEscrow,
    materialActionVerdictEpoch,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
  })
  const dependencyVerdictExchange = buildDependencyVerdictExchange({
    now: input.now,
    namespace: input.namespace,
    database: input.database,
    watchReliability: input.watchReliability,
    rolloutHealth: input.rolloutHealth,
    controllerWitness: input.controllerWitness,
    executionTrust: input.executionTrust.executionTrust,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
  })
  const stageClearancePackets = buildStageClearancePackets({
    now: input.now,
    namespace: input.namespace,
    workflows: input.workflows,
    executionTrust: input.executionTrust.executionTrust,
    swarms: input.executionTrust.swarms,
    stages: input.executionTrust.stages,
    controllerWitness: input.controllerWitness,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    routeStabilityEscrow,
    materialActionVerdictEpoch,
    failureDomainLeases: input.failureDomainLeases,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
    dependencyVerdictExchange,
  })
  const clearanceMarketLedger = isClearanceMarketEnabled()
    ? buildClearanceMarketLedger({
        now: input.now,
        namespace: input.namespace,
        database: input.database,
        agentRunIngestion: input.agentRunIngestion,
        rolloutHealth: input.rolloutHealth,
        workflows: input.workflows,
        executionTrust: input.executionTrust.executionTrust,
        admissionPassports: input.admissionPassports,
        controllerWitness: input.controllerWitness,
        sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
        materialActionVerdictEpoch,
        stageClearancePackets,
        repairWarrants: repairWarrantExchange.active_warrants,
        repairScheduleDebt: repairWarrantExchange.schedule_debt_window,
        torghutConsumerEvidence: input.torghutConsumerEvidence,
      })
    : null
  const stageCreditLedger = isStageCreditLedgerEnabled()
    ? buildStageCreditLedger({
        now: input.now,
        namespace: input.namespace,
        database: input.database,
        workflows: input.workflows,
        agentRunIngestion: input.agentRunIngestion,
        controllerWitness: input.controllerWitness,
        stageClearancePackets,
        clearanceMarketLedger,
        torghutConsumerEvidence: input.torghutConsumerEvidence,
      })
    : null

  return {
    repairWarrantExchange,
    materialActionVerdictEpoch,
    routeStabilityEscrow,
    materialActionActivationReceipts,
    stageClearancePackets,
    dependencyVerdictExchange,
    clearanceMarketLedger,
    stageCreditLedger,
    ...actionCustodyProjection,
  }
}
