import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import { buildReconciledActionClocks } from '~/server/control-plane-action-clock'
import { buildAuthorityProvenanceSettlement } from '~/server/control-plane-authority-provenance-settlement'
import {
  buildControllerStatusFromHeartbeat,
  buildLocalControlPlaneAuthority,
  buildRuntimeAdapterStatusFromSource,
} from '~/server/control-plane-authority-status'
import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import { buildControllerWitnessQuorum } from '~/server/control-plane-controller-witness'
import { buildConsumerEvidenceLeaseSet } from '~/server/control-plane-consumer-evidence-leases'
import {
  buildEvidencePressureLedger,
  isEvidencePressureLedgerEnabled,
  type EvidencePressureGithubIngestStatus,
  type EvidencePressureMetricsSinkStatus,
} from '~/server/control-plane-evidence-pressure-ledger'
import {
  buildTerminalDebtCompactionLedger,
  collectTerminalDebtEvidence,
  emptyTerminalDebtEvidence,
  isTerminalDebtCompactionEnabled,
  type TerminalDebtCompactionEvidence,
} from '~/server/control-plane-terminal-debt-compaction'
import {
  buildControlPlaneMaterialActionArtifacts,
  type RepairScheduleAttemptResolver,
} from '~/server/control-plane-material-action-artifacts'
import {
  createControlPlaneHeartbeatStore,
  type ControlPlaneHeartbeatRow,
  type ControlPlaneHeartbeatStoreGetInput,
} from '~/server/control-plane-heartbeat-store'
import { buildRuntimeAdmissionSnapshot, type RuntimeAdmissionSnapshot } from '~/server/control-plane-runtime-admission'
import { checkDatabase } from '~/server/control-plane-db-status'
import { buildControlPlaneDegradedComponents } from '~/server/control-plane-status-degraded-components'
import {
  buildExecutionTrust,
  resolveExecutionTrustSummaryLimit,
  type ExecutionTrustInput,
  type ExecutionTrustSnapshot,
} from '~/server/control-plane-execution-trust'
import { resolveEmpiricalServices } from '~/server/control-plane-empirical-services'
import {
  buildFailureDomainLeaseSet,
  collectFailureDomainKubernetesEvidence,
  emptyFailureDomainKubernetesEvidence,
  resolveFailureDomainRouteProbe,
  type FailureDomainKubernetesEvidence,
  type FailureDomainRouteProbe,
} from '~/server/control-plane-failure-domain-leases'
import { buildControlPlaneLeaderElectionStatus } from '~/server/control-plane-leader-election-status'
import { buildNegativeEvidenceRouterStatus } from '~/server/control-plane-negative-evidence-router'
import { buildReadyTruthArbiter } from '~/server/control-plane-ready-truth-arbiter'
import { buildDefaultRepairBidAdmissionState } from '~/server/control-plane-repair-bid-admission'
import {
  buildRolloutHealth,
  maybeUseSplitTopologyControllerRollout,
  maybeUseSplitTopologyRuntimeRollout,
  unknownRolloutHealth,
} from '~/server/control-plane-rollout-health'
import {
  buildSourceRolloutTruthExchange,
  resolveSourceRolloutTruthEnvironment,
} from '~/server/control-plane-source-rollout-truth-exchange'
import { buildSourceServingContractVerdictExchange } from '~/server/control-plane-source-serving-contract-verdict'
import {
  resolveTorghutConsumerEvidence,
  type TorghutConsumerEvidenceResolution,
} from '~/server/control-plane-torghut-consumer-evidence'
import { attachStageClearanceCustodyToTorghutEvidence } from '~/server/control-plane-torghut-stage-custody'
import type {
  AgentRunIngestionStatus,
  ControlPlaneStatus,
  ControllerStatus,
  DatabaseStatus,
  GrpcStatus,
  RuntimeAdapterStatus,
} from '~/server/control-plane-status-types'
import {
  buildDependencyQuorum,
  resolveWatchReliabilityBlockErrorsThreshold,
  resolveWatchReliabilityBlockRestartsThreshold,
  resolveWorkflowNamespaces,
  resolveWorkflowSwarms,
  resolveWorkflowWindowMinutes,
  resolveWorkflowsReliabilityStatus,
  type WorkflowsReliabilityStatusInput,
} from '~/server/control-plane-workflows'
import {
  getWatchReliabilitySummary,
  type ControlPlaneWatchReliabilitySummary,
} from '~/server/control-plane-watch-reliability'
import { createKubeGateway, type KubeGateway } from '~/server/kube-gateway'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import { getGithubReviewIngestPressureSummary } from '~/server/github-review-ingest'
import { getMetricsSinkPressureSummary } from '~/server/metrics'
import type { ExecutionTrustStatus, WorkflowsReliabilityStatus } from '~/data/agents-control-plane'

export type { ControlPlaneStatus, DatabaseStatus, GrpcStatus } from './control-plane-status-types'
export { buildExecutionTrust } from './control-plane-execution-trust'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export type ControlPlaneStatusOptions = {
  namespace: string
  service?: string
  grpc: GrpcStatus
}

export type ControlPlaneStatusDeps = {
  now?: () => Date
  getAgentsControllerHealth?: () => ControllerHealth
  getSupportingControllerHealth?: () => ControllerHealth
  getOrchestrationControllerHealth?: () => ControllerHealth
  getHeartbeat?: (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
  getWatchReliabilitySummary?: () => ControlPlaneWatchReliabilitySummary
  getWorkflowsReliabilityStatus?: (input: WorkflowsReliabilityStatusInput) => Promise<WorkflowsReliabilityStatus>
  resolveEmpiricalServices?: typeof resolveEmpiricalServices
  resolveTorghutConsumerEvidence?: typeof resolveTorghutConsumerEvidence
  resolveExecutionTrust?: (input: ExecutionTrustInput) => Promise<ExecutionTrustSnapshot>
  resolveRuntimeAdmission?: (input: { now: Date; executionTrust: ExecutionTrustStatus }) => RuntimeAdmissionSnapshot
  resolveRepairScheduleAttempts?: RepairScheduleAttemptResolver
  resolveMetricsSinkPressure?: () => EvidencePressureMetricsSinkStatus
  resolveGithubIngestPressure?: () => EvidencePressureGithubIngestStatus
  resolveTerminalDebtEvidence?: (input: {
    namespace: string
    kube: KubeGateway
  }) => Promise<TerminalDebtCompactionEvidence>
  resolveRouteProbe?: (input: { now: Date; namespace: string; service: string }) => Promise<FailureDomainRouteProbe>
  resolveFailureDomainKubernetesEvidence?: (input: {
    now: Date
    namespace: string
    service: string
    kube: KubeGateway
  }) => Promise<FailureDomainKubernetesEvidence>
  kubeGateway?: KubeGateway
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

type HeartbeatResolver = (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>

let sharedHeartbeatStore: ReturnType<typeof createControlPlaneHeartbeatStore> | null = null
let heartbeatStoreUnavailable = false

const resolveHeartbeatStore = () => {
  if (sharedHeartbeatStore) return sharedHeartbeatStore
  if (heartbeatStoreUnavailable) return null

  try {
    sharedHeartbeatStore = createControlPlaneHeartbeatStore()
    return sharedHeartbeatStore
  } catch (error) {
    heartbeatStoreUnavailable = true
    console.warn('[jangar] control-plane heartbeat store unavailable:', normalizeMessage(error))
    return null
  }
}

const defaultGetHeartbeat: HeartbeatResolver = async (input) => {
  const store = resolveHeartbeatStore()
  if (!store) return null
  try {
    return await store.getHeartbeat(input)
  } catch (error) {
    console.warn('[jangar] failed to read control-plane heartbeat:', normalizeMessage(error))
    return null
  }
}

const buildAgentRunIngestionStatus = (namespace: string, health: ControllerHealth): AgentRunIngestionStatus => {
  const assessment = assessAgentRunIngestion(namespace, health)

  return {
    namespace,
    status: assessment.status,
    message: assessment.message,
    last_watch_event_at: assessment.lastWatchEventAt,
    last_resync_at: assessment.lastResyncAt,
    untouched_run_count: assessment.untouchedRunCount,
    oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
  }
}

const buildServingProcessControllerStatus = (
  namespace: string,
  health: ControllerHealth,
  now: Date,
): ControllerStatus => {
  const status =
    health.started && health.crdsReady !== false
      ? 'healthy'
      : health.crdsReady === false
        ? 'degraded'
        : health.enabled
          ? 'unknown'
          : 'disabled'

  return {
    name: 'agents-controller',
    enabled: health.enabled,
    started: health.started,
    scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
    crds_ready: health.crdsReady === true,
    missing_crds: health.missingCrds,
    last_checked_at: health.lastCheckedAt ?? '',
    status,
    message:
      status === 'healthy'
        ? 'serving process controller state is current'
        : status === 'disabled'
          ? 'serving process controller disabled'
          : status === 'degraded'
            ? 'serving process controller degraded'
            : 'serving process controller not started',
    authority: {
      mode: 'local',
      namespace,
      source_deployment: '',
      source_pod: '',
      observed_at: now.toISOString(),
      fresh: true,
      message: 'serving process local controller state',
    },
  }
}

const resolveTemporalAdapter = async (): Promise<RuntimeAdapterStatus> => {
  try {
    const config = await loadTemporalConfig({
      defaults: { host: DEFAULT_TEMPORAL_HOST, port: DEFAULT_TEMPORAL_PORT, address: DEFAULT_TEMPORAL_ADDRESS },
    })
    return {
      name: 'temporal',
      available: true,
      status: 'configured',
      message: 'temporal configuration resolved',
      endpoint: config.address ?? DEFAULT_TEMPORAL_ADDRESS,
      authority: buildLocalControlPlaneAuthority('agents'),
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
      authority: buildLocalControlPlaneAuthority('agents'),
    }
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const now = (deps.now ?? (() => new Date()))()
  const kubeGateway = deps.kubeGateway ?? createKubeGateway()
  const heartbeatResolver = deps.getHeartbeat ?? defaultGetHeartbeat
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const [agentsHeartbeat, supportingHeartbeat, orchestrationHeartbeat, workflowRuntimeHeartbeat] = await Promise.all([
    heartbeatResolver({ namespace: options.namespace, component: 'agents-controller', workloadRole: 'controllers' }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'supporting-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'orchestration-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({ namespace: options.namespace, component: 'workflow-runtime', workloadRole: 'controllers' }),
  ])

  const agentsController = buildControllerStatusFromHeartbeat({
    name: 'agents-controller',
    health: agentsHealth,
    heartbeat: agentsHeartbeat,
    now,
  })
  const supportingController = buildControllerStatusFromHeartbeat({
    name: 'supporting-controller',
    health: supportingHealth,
    heartbeat: supportingHeartbeat,
    now,
  })
  const orchestrationController = buildControllerStatusFromHeartbeat({
    name: 'orchestration-controller',
    health: orchestrationHealth,
    heartbeat: orchestrationHeartbeat,
    now,
  })
  const workflowRuntimeController = buildControllerStatusFromHeartbeat({
    name: 'workflow-runtime',
    health: agentsHealth,
    heartbeat: workflowRuntimeHeartbeat,
    now,
  })
  const workflowAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'workflow',
    source: workflowRuntimeController,
    healthyMessage: 'native workflow runtime via Kubernetes Jobs',
    defaultMessage: 'workflow runtime unavailable',
  })
  const jobAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'job',
    source: workflowRuntimeController,
    healthyMessage: 'job runtime via Kubernetes Jobs',
    defaultMessage: 'job runtime unavailable',
  })

  const runtimeAdapters: RuntimeAdapterStatus[] = [
    workflowAdapter,
    jobAdapter,
    await (deps.resolveTemporalAdapter ?? resolveTemporalAdapter)(),
    {
      name: 'custom',
      available: true,
      status: 'unknown',
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
      authority: buildLocalControlPlaneAuthority('agents'),
    },
  ]

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc
  const watchReliability = (deps.getWatchReliabilitySummary ?? getWatchReliabilitySummary)()
  let rolloutHealth
  try {
    rolloutHealth = await buildRolloutHealth({ namespace: options.namespace, kube: kubeGateway })
  } catch {
    rolloutHealth = unknownRolloutHealth()
  }

  const effectiveControllers = [
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: agentsController,
      healthEnabled: agentsHealth.enabled,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: supportingController,
      healthEnabled: supportingHealth.enabled,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: orchestrationController,
      healthEnabled: orchestrationHealth.enabled,
      rolloutHealth,
    }),
  ]
  const effectiveRuntimeAdapters = runtimeAdapters.map((adapter) =>
    maybeUseSplitTopologyRuntimeRollout({
      namespace: options.namespace,
      now,
      adapter,
      healthEnabled: agentsHealth.enabled,
      rolloutHealth,
    }),
  )

  const statusConfig = resolveControlPlaneStatusConfig(process.env)
  const warningBackoffThreshold = statusConfig.workflowsWarningBackoffThreshold
  const degradedBackoffThreshold = statusConfig.workflowsDegradedBackoffThreshold
  const watchReliabilityBlockErrorsThreshold = resolveWatchReliabilityBlockErrorsThreshold()
  const watchReliabilityBlockRestartsThreshold = resolveWatchReliabilityBlockRestartsThreshold()
  const watchReliabilityStatus = {
    status: watchReliability.status,
    window_minutes: watchReliability.window_minutes,
    observed_streams: watchReliability.observed_streams,
    total_events: watchReliability.total_events,
    total_errors: watchReliability.total_errors,
    total_restarts: watchReliability.total_restarts,
    streams: watchReliability.streams,
  }
  const executionTrust = await (deps.resolveExecutionTrust ?? buildExecutionTrust)({
    namespace: options.namespace,
    now,
    swarms: resolveWorkflowSwarms(),
    kube: kubeGateway,
    summaryLimit: resolveExecutionTrustSummaryLimit(),
  }).catch(
    (error: unknown): ExecutionTrustSnapshot => ({
      executionTrust: {
        status: 'unknown',
        reason: `execution trust evaluation failed: ${normalizeMessage(error)}`,
        last_evaluated_at: now.toISOString(),
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    }),
  )

  const workflows = await (deps.getWorkflowsReliabilityStatus ?? resolveWorkflowsReliabilityStatus)({
    now,
    namespace: options.namespace,
    namespaces: resolveWorkflowNamespaces(options.namespace),
    windowMinutes: resolveWorkflowWindowMinutes(),
    swarms: resolveWorkflowSwarms(),
    kube: kubeGateway,
  })
  const empiricalServices = await (deps.resolveEmpiricalServices ?? resolveEmpiricalServices)()
  const runtimeAdmission = (deps.resolveRuntimeAdmission ?? buildRuntimeAdmissionSnapshot)({
    now,
    executionTrust: executionTrust.executionTrust,
  })
  const service = options.service ?? 'jangar'
  const [routeProbe, failureDomainKubernetesEvidence] = await Promise.all([
    (deps.resolveRouteProbe ?? resolveFailureDomainRouteProbe)({
      now,
      namespace: options.namespace,
      service,
    }).catch((error: unknown): FailureDomainRouteProbe => {
      const observedAt = now.toISOString()
      return {
        status: 'unknown',
        reachable: false,
        url: null,
        status_code: null,
        latency_ms: 0,
        message: `route probe failed: ${normalizeMessage(error)}`,
        observed_at: observedAt,
      }
    }),
    (deps.resolveFailureDomainKubernetesEvidence ?? collectFailureDomainKubernetesEvidence)({
      now,
      namespace: options.namespace,
      service,
      kube: kubeGateway,
    }).catch(
      (error: unknown): FailureDomainKubernetesEvidence => ({
        ...emptyFailureDomainKubernetesEvidence(),
        collection_errors: [`kubernetes evidence collection failed: ${normalizeMessage(error)}`],
      }),
    ),
  ])
  const failureDomainLeases = buildFailureDomainLeaseSet({
    now,
    namespace: options.namespace,
    service,
    database,
    routeProbe,
    rolloutHealth,
    workflows,
    runtimeKits: runtimeAdmission.runtimeKits,
    kubernetesEvidence: failureDomainKubernetesEvidence,
  })
  const reconciledActionClocks = buildReconciledActionClocks({
    now,
    namespace: options.namespace,
    failureDomainLeases,
    database,
    rolloutHealth,
    workflows,
    watchReliability: watchReliabilityStatus,
    empiricalServices,
  })

  const isWorkflowsDataUnknown = workflows.data_confidence === 'unknown'
  const isWorkflowsDataDegraded = workflows.data_confidence === 'degraded'
  const isWorkflowsDataUnavailable = isWorkflowsDataUnknown || isWorkflowsDataDegraded
  const isWorkflowsWarning = workflows.backoff_limit_exceeded_jobs >= warningBackoffThreshold
  const isWorkflowsDegraded = workflows.backoff_limit_exceeded_jobs >= degradedBackoffThreshold
  const agentRunIngestion = buildAgentRunIngestionStatus(options.namespace, agentsHealth)
  const servingProcessController = buildServingProcessControllerStatus(options.namespace, agentsHealth, now)
  const effectiveAgentsController =
    effectiveControllers.find((controller) => controller.name === 'agents-controller') ?? agentsController
  const controllerWitness = buildControllerWitnessQuorum({
    now,
    namespace: options.namespace,
    servingController: servingProcessController,
    effectiveController: effectiveAgentsController,
    rolloutHealth,
    watchReliability: watchReliabilityStatus,
    agentRunIngestion,
  })
  const dependencyQuorum = buildDependencyQuorum({
    controllers: effectiveControllers,
    runtimeAdapters: effectiveRuntimeAdapters,
    database,
    empiricalServices,
    watchReliability,
    workflows,
    rolloutHealth,
    now,
    warningBackoffThreshold,
    degradedBackoffThreshold,
    watchReliabilityBlockErrorsThreshold,
    watchReliabilityBlockRestartsThreshold,
    executionTrust: executionTrust.executionTrust,
  })
  const sourceRolloutTruthEnvironment = resolveSourceRolloutTruthEnvironment()
  const buildMaterialStatus = async (torghutConsumerEvidence: TorghutConsumerEvidenceResolution) => {
    const negativeEvidenceRouter = buildNegativeEvidenceRouterStatus({
      now,
      namespace: options.namespace,
      service,
      workflows,
      watchReliability: watchReliabilityStatus,
      agentRunIngestion,
      database,
      rolloutHealth,
      dependencyQuorum,
      failureDomainLeases,
      empiricalServices,
      executionTrust: executionTrust.executionTrust,
      runtimeKits: runtimeAdmission.runtimeKits,
      controllerWitness,
      torghut: torghutConsumerEvidence.negativeEvidence,
    })
    const sourceRolloutTruthExchange = buildSourceRolloutTruthExchange({
      now,
      namespace: options.namespace,
      service,
      sourceHeadSha: sourceRolloutTruthEnvironment.sourceHeadSha,
      gitopsRevision: sourceRolloutTruthEnvironment.gitopsRevision,
      runtimeKits: runtimeAdmission.runtimeKits,
      kubernetesEvidence: failureDomainKubernetesEvidence,
      controllerWitness,
      routeProbe,
      database,
      watchReliability: watchReliabilityStatus,
      rolloutHealth,
      actionSloBudgets: negativeEvidenceRouter.budgets,
      torghutActionSloBudgets: negativeEvidenceRouter.torghutBudgets,
    })
    const materialArtifacts = await buildControlPlaneMaterialActionArtifacts({
      now,
      namespace: options.namespace,
      service,
      kube: kubeGateway,
      agentRunIngestion,
      admissionPassports: runtimeAdmission.admissionPassports,
      dependencyQuorum,
      workflows,
      negativeEvidenceRouter,
      reconciledActionClocks,
      rolloutHealth,
      controllerWitness,
      database,
      watchReliability: watchReliabilityStatus,
      empiricalServices,
      sourceRolloutTruthExchange,
      failureDomainLeases,
      executionTrust,
      routeProbe,
      torghutConsumerEvidence: torghutConsumerEvidence.status,
      resolveRepairScheduleAttempts: deps.resolveRepairScheduleAttempts,
    })

    return { negativeEvidenceRouter, sourceRolloutTruthExchange, materialArtifacts }
  }

  let torghutConsumerEvidence = await (deps.resolveTorghutConsumerEvidence ?? resolveTorghutConsumerEvidence)(now)
  let materialStatus = await buildMaterialStatus(torghutConsumerEvidence)
  const attachedStageCustody = attachStageClearanceCustodyToTorghutEvidence(
    torghutConsumerEvidence,
    materialStatus.materialArtifacts.stageClearancePackets,
    now,
  )
  if (attachedStageCustody.attached) {
    torghutConsumerEvidence = attachedStageCustody.resolution
    materialStatus = await buildMaterialStatus(torghutConsumerEvidence)
    torghutConsumerEvidence = attachStageClearanceCustodyToTorghutEvidence(
      torghutConsumerEvidence,
      materialStatus.materialArtifacts.stageClearancePackets,
      now,
    ).resolution
  }
  const { negativeEvidenceRouter, sourceRolloutTruthExchange } = materialStatus
  const {
    repairWarrantExchange,
    materialActionVerdictEpoch,
    routeStabilityEscrow,
    materialActionActivationReceipts,
    actionCustodyReceipts,
    stageClearancePackets,
    readyActionExchange,
    dependencyVerdictExchange,
    clearanceMarketLedger,
    stageCreditLedger,
  } = materialStatus.materialArtifacts
  const repairBidAdmission = buildDefaultRepairBidAdmissionState(now, options.namespace, torghutConsumerEvidence.status)
  const sourceServingContractVerdictExchange = buildSourceServingContractVerdictExchange({
    now,
    namespace: options.namespace,
    sourceRolloutTruthExchange,
    rolloutHealth,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const readyTruthArbiter = buildReadyTruthArbiter({
    now,
    namespace: options.namespace,
    database,
    rolloutHealth,
    runtimeAdapters: effectiveRuntimeAdapters,
    admissionPassports: runtimeAdmission.admissionPassports,
    controllerWitness,
    executionTrust: executionTrust.executionTrust,
    stageCreditLedger,
    sourceServingContractVerdictExchange,
    repairBidAdmission,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const authorityProvenanceSettlement = buildAuthorityProvenanceSettlement({
    now,
    namespace: options.namespace,
    database,
    rolloutHealth,
    runtimeAdapters: effectiveRuntimeAdapters,
    workflows,
    watchReliability: watchReliabilityStatus,
    agentRunIngestion,
    controllerWitness,
    sourceRolloutTruthExchange,
    sourceServingContractVerdictExchange,
    stageClearancePackets,
    actionSloBudgets: negativeEvidenceRouter.budgets,
    projectionWatermarks: runtimeAdmission.projectionWatermarks,
    stageCreditLedger,
    readyTruthArbiter,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const evidencePressureLedger = isEvidencePressureLedgerEnabled()
    ? buildEvidencePressureLedger({
        now,
        namespace: options.namespace,
        sourceHeadSha: sourceRolloutTruthEnvironment.sourceHeadSha,
        gitopsRevision: sourceRolloutTruthEnvironment.gitopsRevision,
        watchReliability: watchReliabilityStatus,
        controllerWitness,
        rolloutHealth,
        database,
        metricsSink: (deps.resolveMetricsSinkPressure ?? getMetricsSinkPressureSummary)(),
        githubIngest: (deps.resolveGithubIngestPressure ?? getGithubReviewIngestPressureSummary)(),
        torghutConsumerEvidence: torghutConsumerEvidence.status,
      })
    : null
  const terminalDebtCompactionLedger = isTerminalDebtCompactionEnabled()
    ? buildTerminalDebtCompactionLedger({
        now,
        namespace: options.namespace,
        workflows,
        watchReliability: watchReliabilityStatus,
        controllerWitness,
        stageCreditLedger,
        readyTruthArbiter,
        repairBidAdmission,
        torghutConsumerEvidence: torghutConsumerEvidence.status,
        ...(await (deps.resolveTerminalDebtEvidence ?? collectTerminalDebtEvidence)({
          namespace: options.namespace,
          kube: kubeGateway,
        }).catch(
          (error: unknown): TerminalDebtCompactionEvidence => ({
            ...emptyTerminalDebtEvidence(),
            collectionErrors: [`terminal debt evidence collection failed: ${normalizeMessage(error)}`],
          }),
        )),
      })
    : null
  const consumerEvidenceLeases = buildConsumerEvidenceLeaseSet({
    now,
    namespace: options.namespace,
    database,
    rolloutHealth,
    watchReliability: watchReliabilityStatus,
    controllerWitness,
    materialActionVerdictEpoch,
    empiricalServices,
  })

  const degradedComponents = buildControlPlaneDegradedComponents({
    agentRunIngestion,
    database,
    effectiveControllers,
    effectiveRuntimeAdapters,
    empiricalServices,
    executionTrust,
    grpcStatus,
    rolloutHealth,
    runtimeKits: runtimeAdmission.runtimeKits,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
    watchReliabilityStatus,
    workflowFlags: [isWorkflowsDataUnavailable, isWorkflowsWarning, isWorkflowsDegraded, isWorkflowsDataUnknown],
  })

  return {
    service,
    generated_at: now.toISOString(),
    leader_election: buildControlPlaneLeaderElectionStatus(),
    controllers: effectiveControllers,
    runtime_adapters: effectiveRuntimeAdapters,
    execution_trust: executionTrust.executionTrust,
    database,
    grpc: grpcStatus,
    watch_reliability: watchReliabilityStatus,
    agentrun_ingestion: agentRunIngestion,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    recovery_warrants: runtimeAdmission.recoveryWarrants,
    runtime_proof_cells: runtimeAdmission.runtimeProofCells,
    projection_watermarks: runtimeAdmission.projectionWatermarks,
    rollout_health: rolloutHealth,
    swarms: executionTrust.swarms,
    stages: executionTrust.stages,
    workflows,
    dependency_quorum: dependencyQuorum,
    failure_domain_leases: failureDomainLeases,
    reconciled_action_clocks: reconciledActionClocks,
    negative_evidence_router: negativeEvidenceRouter.router,
    action_slo_budgets: negativeEvidenceRouter.budgets,
    torghut_action_slo_budgets: negativeEvidenceRouter.torghutBudgets,
    dependency_verdict_exchange: dependencyVerdictExchange,
    source_serving_contract_verdict_exchange: sourceServingContractVerdictExchange,
    control_plane_controller_witness: controllerWitness,
    material_action_verdict_epoch: materialActionVerdictEpoch,
    material_action_verdicts: materialActionVerdictEpoch.final_verdicts,
    material_action_activation_receipts: materialActionActivationReceipts,
    action_custody_receipts: actionCustodyReceipts,
    stage_clearance_packets: stageClearancePackets,
    stage_credit_ledger: stageCreditLedger,
    ready_truth_arbiter: readyTruthArbiter,
    authority_provenance_settlement: authorityProvenanceSettlement,
    evidence_pressure_ledger: evidencePressureLedger,
    terminal_debt_compaction_ledger: terminalDebtCompactionLedger,
    ready_action_exchange: readyActionExchange,
    repair_bid_admission: repairBidAdmission,
    repair_warrant_exchange: repairWarrantExchange,
    consumer_evidence_leases: consumerEvidenceLeases,
    clearance_market_ledger: clearanceMarketLedger,
    source_rollout_truth_exchange: sourceRolloutTruthExchange,
    route_stability_escrow: routeStabilityEscrow,
    empirical_services: empiricalServices,
    torghut_consumer_evidence: torghutConsumerEvidence.status,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
