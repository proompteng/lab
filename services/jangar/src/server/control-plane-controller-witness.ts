import { createHash } from 'node:crypto'

import type {
  ActionSloBudget,
  ControlPlaneControllerWitness,
  ControlPlaneControllerWitnessQuorum,
  ControllerWitnessDecision,
  MaterialActionVerdict,
  MaterialActionVerdictDecision,
  MaterialActionVerdictEpoch,
  MaterialActionActivationReceipt,
  MaterialActionActivationReceiptCapitalStage,
  MaterialActionActivationReceiptDecision,
  NegativeEvidenceRouterStatus,
  RouteStabilityEscrow,
} from '~/data/agents-control-plane'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  DeploymentRolloutStatus,
} from '~/server/control-plane-status-types'

export const CONTROLLER_WITNESS_DESIGN_ARTIFACT =
  'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md'

const DEFAULT_WITNESS_FRESHNESS_MINUTES = 5

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000)

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const findControllerDeployment = (rolloutHealth: ControlPlaneRolloutHealth, namespace: string) =>
  rolloutHealth.deployments.find(
    (deployment) => deployment.namespace === namespace && deployment.name === 'agents-controllers',
  ) ?? null

const isDeploymentAvailable = (deployment: DeploymentRolloutStatus | null) =>
  Boolean(
    deployment &&
    (deployment.status === 'healthy' ||
      (deployment.status === 'degraded' && deployment.ready_replicas > 0 && deployment.available_replicas > 0)),
  )

const watchEpochId = (watchReliability: ControlPlaneWatchReliability) =>
  `watch:${hashJson({
    status: watchReliability.status,
    observed_streams: watchReliability.observed_streams,
    total_events: watchReliability.total_events,
    total_errors: watchReliability.total_errors,
    total_restarts: watchReliability.total_restarts,
    streams: watchReliability.streams.map((stream) => ({
      namespace: stream.namespace,
      resource: stream.resource,
      last_seen_at: stream.last_seen_at,
      events: stream.events,
      errors: stream.errors,
      restarts: stream.restarts,
    })),
  })}`

const ingestionEpochId = (agentRunIngestion: AgentRunIngestionStatus) =>
  `ingestion:${hashJson({
    namespace: agentRunIngestion.namespace,
    status: agentRunIngestion.status,
    last_watch_event_at: agentRunIngestion.last_watch_event_at,
    last_resync_at: agentRunIngestion.last_resync_at,
    untouched_run_count: agentRunIngestionUntouchedCount(agentRunIngestion),
    oldest_untouched_age_seconds: agentRunIngestion.oldest_untouched_age_seconds,
  })}`

const agentRunIngestionUntouchedCount = (agentRunIngestion: AgentRunIngestionStatus) =>
  Math.max(0, agentRunIngestion.untouched_run_count)

const buildWitnessId = (input: {
  namespace: string
  surface: ControlPlaneControllerWitness['controller_surface']
  decision: ControllerWitnessDecision
  reasonCodes: string[]
  refs: Record<string, unknown>
}) =>
  `witness:${input.surface}:${hashJson({
    namespace: input.namespace,
    decision: input.decision,
    reason_codes: input.reasonCodes,
    refs: input.refs,
  })}`

const controllerProcessDecision = (controller: ControllerStatus): ControllerWitnessDecision => {
  if (controller.status === 'healthy' && controller.started) return 'allow'
  if (controller.status === 'degraded') return 'repair_only'
  if (controller.status === 'disabled' || controller.status === 'unknown') return 'repair_only'
  return 'hold_material'
}

const controllerProcessReasons = (controller: ControllerStatus) => {
  if (controller.status === 'healthy' && controller.started) return []
  if (controller.status === 'disabled') return ['controller_self_report_disabled']
  if (controller.status === 'unknown') return ['controller_self_report_unknown']
  if (controller.status === 'degraded') return ['controller_self_report_degraded']
  return ['controller_self_report_unhealthy']
}

const deploymentReasons = (deployment: DeploymentRolloutStatus | null, deploymentAvailable: boolean) => {
  if (deploymentAvailable) return []
  if (!deployment) return ['controller_deployment_missing']
  if (deployment.status === 'disabled') return ['controller_deployment_disabled']
  if (deployment.status === 'unknown') return ['controller_deployment_unknown']
  return ['controller_deployment_unavailable']
}

const watchReasons = (watchReliability: ControlPlaneWatchReliability) => {
  if (watchReliability.status === 'healthy') return []
  if (watchReliability.status === 'unknown') return ['watch_epoch_unknown']
  return ['watch_epoch_degraded']
}

const ingestionReasons = (agentRunIngestion: AgentRunIngestionStatus) => {
  if (agentRunIngestion.status === 'healthy') return []
  if (agentRunIngestion.status === 'degraded') return ['controller_ingestion_stalled']
  return ['controller_ingestion_unknown']
}

const buildWitness = (input: {
  now: Date
  expiresAt: string
  namespace: string
  surface: ControlPlaneControllerWitness['controller_surface']
  decision: ControllerWitnessDecision
  reasonCodes: string[]
  deploymentRef?: string | null
  podUid?: string | null
  imageRef?: string | null
  leaderIdentity?: string | null
  controllerStarted?: boolean | null
  deploymentAvailable?: boolean | null
  watchEpochId?: string | null
  ingestionEpochId?: string | null
  lastWatchEventAt?: string | null
  lastResyncAt?: string | null
  observedRunCount?: number | null
  untouchedRunCount?: number | null
}): ControlPlaneControllerWitness => ({
  witness_id: buildWitnessId({
    namespace: input.namespace,
    surface: input.surface,
    decision: input.decision,
    reasonCodes: input.reasonCodes,
    refs: {
      deployment_ref: input.deploymentRef ?? null,
      watch_epoch_id: input.watchEpochId ?? null,
      ingestion_epoch_id: input.ingestionEpochId ?? null,
      last_watch_event_at: input.lastWatchEventAt ?? null,
      last_resync_at: input.lastResyncAt ?? null,
      untouched_run_count: input.untouchedRunCount ?? null,
    },
  }),
  generated_at: input.now.toISOString(),
  expires_at: input.expiresAt,
  namespace: input.namespace,
  controller_surface: input.surface,
  deployment_ref: input.deploymentRef ?? null,
  pod_uid: input.podUid ?? null,
  image_ref: input.imageRef ?? null,
  leader_identity: input.leaderIdentity ?? null,
  controller_started: input.controllerStarted ?? null,
  deployment_available: input.deploymentAvailable ?? null,
  watch_epoch_id: input.watchEpochId ?? null,
  ingestion_epoch_id: input.ingestionEpochId ?? null,
  last_watch_event_at: input.lastWatchEventAt ?? null,
  last_resync_at: input.lastResyncAt ?? null,
  observed_run_count: input.observedRunCount ?? null,
  untouched_run_count: input.untouchedRunCount ?? null,
  decision: input.decision,
  reason_codes: input.reasonCodes,
})

const resolveQuorumDecision = (input: {
  servingController: ControllerStatus
  effectiveController: ControllerStatus
  deploymentAvailable: boolean
  watchHealthy: boolean
  agentRunIngestion: AgentRunIngestionStatus
}): { decision: ControllerWitnessDecision; reasonCodes: string[]; message: string; rollbackTarget: string | null } => {
  const selfReportCurrent =
    input.effectiveController.status === 'healthy' &&
    input.effectiveController.started &&
    (input.effectiveController.authority.mode === 'heartbeat' || input.servingController.started)

  if (input.agentRunIngestion.status === 'degraded') {
    return {
      decision: 'hold_material',
      reasonCodes: ['controller_ingestion_stalled'],
      message: input.agentRunIngestion.message || 'AgentRun ingestion stalled under current controller witnesses.',
      rollbackTarget: 'hold normal dispatch and repair AgentRun ingestion before material action',
    }
  }

  if (selfReportCurrent) {
    return {
      decision: input.servingController.started ? 'allow' : 'allow_with_split',
      reasonCodes: input.servingController.started ? [] : ['controller_process_heartbeat_authoritative'],
      message: input.servingController.started
        ? 'controller self-report and AgentRun ingestion are current'
        : 'controller heartbeat is authoritative while serving process is not the controller',
      rollbackTarget: null,
    }
  }

  if (input.deploymentAvailable && input.watchHealthy) {
    return {
      decision: 'repair_only',
      reasonCodes: ['controller_witness_split'],
      message: 'controller deployment and watch epoch are current, but controller ingestion self-report is missing',
      rollbackTarget: 'allow bounded repair only until a controller ingestion witness is current',
    }
  }

  return {
    decision: 'hold_material',
    reasonCodes: uniqueStrings([
      ...(input.deploymentAvailable ? [] : ['controller_deployment_unavailable']),
      ...(input.watchHealthy ? [] : ['watch_epoch_not_current']),
      ...ingestionReasons(input.agentRunIngestion),
    ]),
    message: 'controller witnesses are insufficient for material dispatch',
    rollbackTarget: 'hold material action until controller deployment, watch epoch, and ingestion witnesses agree',
  }
}

export const buildControllerWitnessQuorum = (input: {
  now: Date
  namespace: string
  servingController: ControllerStatus
  effectiveController: ControllerStatus
  rolloutHealth: ControlPlaneRolloutHealth
  watchReliability: ControlPlaneWatchReliability
  agentRunIngestion: AgentRunIngestionStatus
}): ControlPlaneControllerWitnessQuorum => {
  const expiresAt = addMinutes(input.now, DEFAULT_WITNESS_FRESHNESS_MINUTES).toISOString()
  const deployment = findControllerDeployment(input.rolloutHealth, input.namespace)
  const deploymentAvailable = isDeploymentAvailable(deployment)
  const deploymentRef = deployment ? `deployment/${deployment.namespace}/${deployment.name}` : null
  const watchId = watchEpochId(input.watchReliability)
  const ingestionId = ingestionEpochId(input.agentRunIngestion)
  const watchHealthy = input.watchReliability.status === 'healthy'
  const controllerReasons = controllerProcessReasons(input.effectiveController)
  const deploymentReasonCodes = deploymentReasons(deployment, deploymentAvailable)
  const watchReasonCodes = watchReasons(input.watchReliability)
  const ingestionReasonCodes = ingestionReasons(input.agentRunIngestion)
  const quorum = resolveQuorumDecision({
    servingController: input.servingController,
    effectiveController: input.effectiveController,
    deploymentAvailable,
    watchHealthy,
    agentRunIngestion: input.agentRunIngestion,
  })
  const witnesses = [
    buildWitness({
      now: input.now,
      expiresAt,
      namespace: input.namespace,
      surface: input.effectiveController.authority.mode === 'heartbeat' ? 'controller_process' : 'serving_process',
      decision: controllerProcessDecision(input.effectiveController),
      reasonCodes: controllerReasons,
      deploymentRef: input.effectiveController.authority.source_deployment
        ? `deployment/${input.namespace}/${input.effectiveController.authority.source_deployment}`
        : null,
      podUid: input.effectiveController.authority.source_pod || null,
      leaderIdentity: input.effectiveController.authority.source_pod || null,
      controllerStarted: input.effectiveController.started,
    }),
    buildWitness({
      now: input.now,
      expiresAt,
      namespace: input.namespace,
      surface: 'kubernetes_deployment',
      decision: deploymentAvailable ? 'allow' : 'hold_material',
      reasonCodes: deploymentReasonCodes,
      deploymentRef,
      deploymentAvailable,
      observedRunCount: deployment?.available_replicas ?? null,
    }),
    buildWitness({
      now: input.now,
      expiresAt,
      namespace: input.namespace,
      surface: 'watch_epoch',
      decision: watchHealthy ? 'allow' : 'hold_material',
      reasonCodes: watchReasonCodes,
      watchEpochId: watchId,
      lastWatchEventAt:
        input.watchReliability.streams
          .map((stream) => stream.last_seen_at)
          .filter((value) => value.trim().length > 0)
          .sort()
          .at(-1) ?? null,
      observedRunCount: input.watchReliability.total_events,
    }),
    buildWitness({
      now: input.now,
      expiresAt,
      namespace: input.namespace,
      surface: 'agentrun_ingestion',
      decision:
        input.agentRunIngestion.status === 'healthy'
          ? 'allow'
          : input.agentRunIngestion.status === 'degraded'
            ? 'hold_material'
            : 'repair_only',
      reasonCodes: ingestionReasonCodes,
      ingestionEpochId: ingestionId,
      lastWatchEventAt: input.agentRunIngestion.last_watch_event_at,
      lastResyncAt: input.agentRunIngestion.last_resync_at,
      untouchedRunCount: input.agentRunIngestion.untouched_run_count,
    }),
  ]
  const witnessRefs = witnesses.map((witness) => witness.witness_id).sort()
  const quorumId = `controller-witness:${hashJson({
    namespace: input.namespace,
    decision: quorum.decision,
    reason_codes: quorum.reasonCodes,
    witness_refs: witnessRefs,
  })}`

  return {
    mode: 'shadow',
    design_artifact: CONTROLLER_WITNESS_DESIGN_ARTIFACT,
    quorum_id: quorumId,
    generated_at: input.now.toISOString(),
    expires_at: expiresAt,
    namespace: input.namespace,
    decision: quorum.decision,
    reason_codes: quorum.reasonCodes,
    message: quorum.message,
    witness_refs: witnessRefs,
    deployment_available: deploymentAvailable,
    watch_epoch_current: watchHealthy,
    controller_self_report_current:
      input.effectiveController.status === 'healthy' &&
      input.effectiveController.started &&
      (input.effectiveController.authority.mode === 'heartbeat' || input.servingController.started),
    witnesses,
    rollback_target: quorum.rollbackTarget,
  }
}

const flattenNegativeEvidenceRefs = (router: NegativeEvidenceRouterStatus) =>
  uniqueStrings(router.negative_evidence_refs.flatMap((entry) => entry.evidence_refs)).sort()

const receiptDecisionFromBudget = (budget: ActionSloBudget): MaterialActionActivationReceiptDecision => {
  if (budget.decision === 'shadow_only') return 'observe_only'
  if (budget.decision === 'allow') return 'allow'
  if (budget.decision === 'observe_only') return 'observe_only'
  if (budget.decision === 'repair_only') return 'repair_only'
  if (budget.decision === 'block') return 'block'
  return 'hold'
}

const receiptDecisionFromVerdict = (
  decision: MaterialActionVerdictDecision,
): MaterialActionActivationReceiptDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'repair_only') return 'repair_only'
  if (decision === 'block') return 'block'
  return 'hold'
}

const capitalStageForAction = (
  actionClass: ActionSloBudget['action_class'],
): MaterialActionActivationReceiptCapitalStage => {
  if (actionClass === 'torghut_observe') return 'observe'
  if (actionClass === 'paper_canary') return 'paper'
  if (actionClass === 'live_micro_canary') return 'live_micro'
  if (actionClass === 'live_scale') return 'live_scale'
  if (actionClass === 'deploy_widen' || actionClass === 'merge_ready') return 'shadow'
  return 'none'
}

const proofFreshnessRefs = (router: NegativeEvidenceRouterStatus) =>
  router.positive_evidence_refs
    .filter(
      (ref) =>
        ref.startsWith('runtime-kit:') ||
        ref.startsWith('watch_reliability:') ||
        ref.startsWith('database:') ||
        ref.startsWith('execution_trust:'),
    )
    .sort()

export const buildMaterialActionActivationReceipts = (input: {
  now: Date
  scope: string
  controllerWitness: ControlPlaneControllerWitnessQuorum
  router: NegativeEvidenceRouterStatus
  budgets: ActionSloBudget[]
  materialActionVerdictEpoch?: MaterialActionVerdictEpoch
  routeStabilityEscrow?: RouteStabilityEscrow
}): MaterialActionActivationReceipt[] =>
  input.budgets.map((budget) => {
    const verdict = input.materialActionVerdictEpoch?.final_verdicts.find(
      (entry: MaterialActionVerdict) => entry.action_class === budget.action_class,
    )
    const decision = verdict ? receiptDecisionFromVerdict(verdict.decision) : receiptDecisionFromBudget(budget)
    const receiptSource = {
      action_class: budget.action_class,
      budget_id: budget.budget_id,
      controller_quorum_id: input.controllerWitness.quorum_id,
      router_epoch_id: input.router.router_epoch_id,
      material_action_verdict_epoch_id: input.materialActionVerdictEpoch?.epoch_id ?? null,
      decision,
      scope: input.scope,
    }

    return {
      receipt_id: `receipt:${budget.action_class}:${hashJson(receiptSource)}`,
      generated_at: input.now.toISOString(),
      expires_at: budget.fresh_until,
      action_class: budget.action_class,
      scope: input.scope,
      controller_witness_refs: input.controllerWitness.witness_refs,
      route_stability_escrow_ref: input.routeStabilityEscrow?.escrow_id ?? null,
      transport_contract_refs: [
        input.router.router_epoch_id,
        input.controllerWitness.quorum_id,
        ...(input.materialActionVerdictEpoch ? [input.materialActionVerdictEpoch.epoch_id] : []),
        ...(input.routeStabilityEscrow ? [input.routeStabilityEscrow.escrow_id] : []),
        ...input.router.failure_domain_lease_refs,
      ],
      proof_freshness_refs: proofFreshnessRefs(input.router),
      positive_authority_refs: input.router.positive_evidence_refs,
      negative_authority_refs: uniqueStrings([
        ...flattenNegativeEvidenceRefs(input.router),
        ...(input.materialActionVerdictEpoch?.contradiction_refs ?? []),
      ]),
      capital_stage: capitalStageForAction(budget.action_class),
      decision,
      max_dispatches: verdict ? verdict.max_dispatches : budget.max_dispatches,
      max_runtime_seconds: verdict ? verdict.max_runtime_seconds : budget.max_runtime_seconds,
      max_notional: verdict ? verdict.max_notional : budget.max_notional,
      required_repairs: verdict ? verdict.required_repair_actions : budget.required_repairs,
      rollback_target: verdict?.rollback_target ?? budget.rollback_target ?? input.controllerWitness.rollback_target,
    }
  })
