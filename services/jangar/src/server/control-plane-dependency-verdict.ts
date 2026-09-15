import { createHash } from 'node:crypto'

import type {
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  DependencyVerdict,
  DependencyVerdictActionClass,
  DependencyVerdictAllowedScope,
  DependencyVerdictDecision,
  DependencyVerdictExchange,
  ExecutionTrustStatus,
  SourceRolloutTruthExchange,
} from '~/server/control-plane-status-types'
import type { ControlPlaneRolloutHealth, ControlPlaneWatchReliability } from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const DEPENDENCY_VERDICT_DESIGN_ARTIFACT =
  'docs/agents/designs/186-jangar-route-warrant-dispatch-custody-and-dependency-verdicts-2026-05-13.md'

const PRODUCER_REVISION = '2026-05-13-route-warrant-dependency-verdict-observe-v1'
const VERDICT_SCHEMA_VERSION = 'jangar.dependency-verdict.v1' as const
const DEFAULT_REPOSITORY = 'proompteng/lab'
const DEFAULT_BRANCH = 'codex/swarm-jangar-control-plane'
const DEFAULT_SWARM_NAME = 'jangar-control-plane'

const ACTION_CLASSES: DependencyVerdictActionClass[] = [
  'serve_readonly',
  'observe',
  'repair',
  'implement',
  'paper',
  'live',
  'deploy_widen',
  'merge_ready',
]

const DECISION_RANK: Record<DependencyVerdictDecision, number> = {
  allow: 0,
  repair_only: 1,
  hold: 2,
  block: 3,
}

type DependencyVerdictInput = {
  now: Date
  namespace: string
  repository?: string
  branch?: string
  swarmName?: string
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  rolloutHealth: ControlPlaneRolloutHealth
  controllerWitness: ControlPlaneControllerWitnessQuorum
  executionTrust: ExecutionTrustStatus
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

type WarrantState = {
  ref: string | null
  state: string | null
  freshUntil: string | null
  fresh: boolean
  maxNotional: number
  routeableCandidateCount: number
  repairPacketRefs: string[]
  targetValueGates: string[]
  blockingDependencies: string[]
  blockingReasons: string[]
  capitalGateSafety: string | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const compactStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const parseIso = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const parsed = values
    .map(parseIso)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return parsed.length > 0 ? new Date(parsed[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const numberValue = (value: string | number | null | undefined) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const stricterDecision = (left: DependencyVerdictDecision, right: DependencyVerdictDecision) =>
  DECISION_RANK[left] >= DECISION_RANK[right] ? left : right

const actionStage = (actionClass: DependencyVerdictActionClass): DependencyVerdict['stage'] => {
  if (actionClass === 'serve_readonly') return 'serve'
  if (actionClass === 'observe') return 'observe'
  if (actionClass === 'repair') return 'repair'
  if (actionClass === 'paper') return 'paper'
  if (actionClass === 'live') return 'live'
  if (actionClass === 'deploy_widen') return 'deploy'
  if (actionClass === 'merge_ready') return 'verify'
  return 'implement'
}

const allowedScope = (
  actionClass: DependencyVerdictActionClass,
  decision: DependencyVerdictDecision,
): DependencyVerdictAllowedScope => {
  if (decision === 'hold' || decision === 'block') return 'none'
  if (decision === 'repair_only') return actionClass === 'repair' ? 'zero_notional_repair' : 'none'
  if (actionClass === 'serve_readonly') return 'read_only'
  if (actionClass === 'observe') return 'observe_only'
  if (actionClass === 'repair') return 'zero_notional_repair'
  if (actionClass === 'implement') return 'normal_implementation'
  if (actionClass === 'paper') return 'paper_support'
  if (actionClass === 'live') return 'live_support'
  return actionClass
}

const dependencyNameForReason = (reason: string) => {
  if (reason.includes('empirical')) return 'empirical'
  if (reason.includes('forecast')) return 'forecast_registry'
  if (reason.includes('submit') || reason.includes('submission')) return 'submission'
  if (reason.includes('tca') || reason.includes('slippage')) return 'active_tca'
  if (reason.includes('ingestion')) return 'ingestion'
  if (reason.includes('materialization')) return 'materialization'
  if (reason.includes('market_context')) return 'market_context'
  if (reason.includes('routeable') || reason.includes('routeability')) return 'routeability'
  if (reason.includes('capital')) return 'capital_gate'
  return null
}

const routeWarrantRef = (status: TorghutConsumerEvidenceStatus) =>
  status.route_warrant_id ?? (status.route_warrant_state ? `torghut-route-warrant:${status.route_warrant_state}` : null)

const resolveWarrantState = (input: DependencyVerdictInput): WarrantState => {
  const status = input.torghutConsumerEvidence
  const ref = routeWarrantRef(status)
  const freshUntil = status.route_warrant_fresh_until ?? status.fresh_until
  const freshUntilMs = parseIso(freshUntil)
  const blockingReasons = compactStrings([
    ...(ref ? [] : ['route_warrant_missing']),
    ...(status.status === 'current' ? [] : [`torghut_consumer_evidence_${status.status}`]),
    ...((status.route_warrant_blocking_reason_codes ?? []).length > 0
      ? (status.route_warrant_blocking_reason_codes ?? [])
      : status.reason_codes),
    ...(status.routeability_aggregate_state && status.routeability_aggregate_state !== 'accepted'
      ? [`routeability_${status.routeability_aggregate_state}`]
      : []),
    ...(status.profit_freshness_state && !['ready', 'current'].includes(status.profit_freshness_state)
      ? [`profit_freshness_${status.profit_freshness_state}`]
      : []),
    ...(status.capital_reentry_aggregate_state &&
    !['allow', 'observe', 'paper_candidate'].includes(status.capital_reentry_aggregate_state)
      ? [`capital_reentry_${status.capital_reentry_aggregate_state}`]
      : []),
    ...(status.profit_repair_aggregate_state &&
    !['allow', 'observe', 'paper_candidate'].includes(status.profit_repair_aggregate_state)
      ? [`profit_repair_${status.profit_repair_aggregate_state}`]
      : []),
  ])
  const repairPacketRefs = compactStrings([
    ...(status.route_warrant_repair_packet_ids ?? []),
    ...(status.routeable_exchange_zero_notional_repair_lot_ids ?? []),
    ...(status.profit_freshness_selected_repair_ids ?? []),
  ])
  const blockingDependencies = compactStrings([
    ...(status.route_warrant_blocking_dependency_names ?? []),
    ...blockingReasons.map(dependencyNameForReason),
    ...(status.evidence_clock_split_clock_names ?? []),
  ])
  const routeableCandidateCount =
    status.accepted_routeable_candidate_count ??
    status.routeable_exchange_routeable_candidate_count ??
    (status.decision === 'allow' ? 1 : 0)

  return {
    ref,
    state: status.route_warrant_state ?? status.decision ?? null,
    freshUntil,
    fresh: Boolean(ref && status.status === 'current' && freshUntilMs && freshUntilMs > input.now.getTime()),
    maxNotional: numberValue(status.max_notional),
    routeableCandidateCount,
    repairPacketRefs,
    targetValueGates: status.route_warrant_repair_target_value_gates ?? [],
    blockingDependencies,
    blockingReasons,
    capitalGateSafety: status.route_warrant_capital_gate_safety ?? null,
  }
}

const executionTrustRef = (executionTrust: ExecutionTrustStatus) =>
  `execution-trust:${hashJson({
    status: executionTrust.status,
    reason: executionTrust.reason,
    blocking_windows: executionTrust.blocking_windows,
  })}`

const argoHealthRef = (rolloutHealth: ControlPlaneRolloutHealth) =>
  `rollout-health:${hashJson({
    status: rolloutHealth.status,
    observed_deployments: rolloutHealth.observed_deployments,
    degraded_deployments: rolloutHealth.degraded_deployments,
    deployments: rolloutHealth.deployments.map((deployment) => ({
      name: deployment.name,
      namespace: deployment.namespace,
      status: deployment.status,
      ready_replicas: deployment.ready_replicas,
      updated_replicas: deployment.updated_replicas,
    })),
  })}`

const watchHealthy = (input: DependencyVerdictInput) =>
  input.watchReliability.status === 'healthy' && input.watchReliability.total_errors === 0

const servingHealthy = (input: DependencyVerdictInput) =>
  input.database.status === 'healthy' &&
  input.database.migration_consistency.status === 'healthy' &&
  watchHealthy(input) &&
  input.controllerWitness.decision !== 'block'

const currentAcceptedWarrant = (warrant: WarrantState) =>
  warrant.fresh &&
  warrant.blockingReasons.length === 0 &&
  warrant.routeableCandidateCount > 0 &&
  ['paper_candidate', 'paper_accepted', 'live_candidate', 'live_accepted', 'accepted', 'allow'].includes(
    warrant.state ?? '',
  )

const requiredValidationCommands = (actionClass: DependencyVerdictActionClass) =>
  compactStrings([
    'curl -fsS http://agents.agents.svc.cluster.local/v1/control-plane/status?namespace=agents | jq .dependency_verdict_exchange',
    'curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq .route_warrant_exchange',
    ...(actionClass === 'paper' || actionClass === 'live'
      ? [
          'curl -fsS http://torghut.torghut.svc.cluster.local/readyz',
          'curl -fsS http://torghut.torghut.svc.cluster.local/trading/health',
        ]
      : []),
  ])

const actionDecision = (input: {
  actionClass: DependencyVerdictActionClass
  statusInput: DependencyVerdictInput
  warrant: WarrantState
}): DependencyVerdictDecision => {
  const { actionClass, statusInput, warrant } = input

  if (actionClass === 'serve_readonly') {
    return servingHealthy(statusInput) ? 'allow' : 'hold'
  }

  if (actionClass === 'observe') {
    return warrant.fresh ? 'allow' : 'hold'
  }

  if (actionClass === 'repair') {
    const repairPacketScoped =
      warrant.repairPacketRefs.length > 0 &&
      warrant.targetValueGates.length > 0 &&
      warrant.repairPacketRefs.length >= warrant.targetValueGates.length
    return warrant.fresh && warrant.maxNotional === 0 && repairPacketScoped ? 'repair_only' : 'hold'
  }

  if (actionClass === 'live') {
    const capitalPass = warrant.capitalGateSafety === 'pass'
    const liveAccepted = warrant.state === 'live_candidate' || warrant.state === 'live_accepted'
    return currentAcceptedWarrant(warrant) && liveAccepted && capitalPass && warrant.maxNotional > 0 ? 'allow' : 'block'
  }

  if (currentAcceptedWarrant(warrant)) {
    if (actionClass === 'paper') {
      return warrant.state === 'paper_candidate' ||
        warrant.state === 'paper_accepted' ||
        warrant.state === 'live_candidate' ||
        warrant.state === 'live_accepted'
        ? 'allow'
        : 'hold'
    }
    return 'allow'
  }

  return 'hold'
}

const actionCaps = (
  actionClass: DependencyVerdictActionClass,
  decision: DependencyVerdictDecision,
  warrant: WarrantState,
) => {
  if (decision === 'hold' || decision === 'block') {
    return { maxDispatches: 0, maxRuntimeSeconds: 0, maxNotional: 0 }
  }
  if (actionClass === 'serve_readonly' || actionClass === 'observe') {
    return { maxDispatches: null, maxRuntimeSeconds: null, maxNotional: 0 }
  }
  if (actionClass === 'repair') {
    return { maxDispatches: 1, maxRuntimeSeconds: 30 * 60, maxNotional: 0 }
  }
  if (actionClass === 'deploy_widen' || actionClass === 'merge_ready') {
    return { maxDispatches: 1, maxRuntimeSeconds: 30 * 60, maxNotional: 0 }
  }
  return {
    maxDispatches: 1,
    maxRuntimeSeconds: 60 * 60,
    maxNotional: actionClass === 'live' || actionClass === 'paper' ? warrant.maxNotional : 0,
  }
}

const buildVerdict = (input: {
  statusInput: DependencyVerdictInput
  warrant: WarrantState
  actionClass: DependencyVerdictActionClass
  freshUntil: string
  executionTrustRef: string
  argoHealthRef: string
}) => {
  const decision = actionDecision(input)
  const caps = actionCaps(input.actionClass, decision, input.warrant)
  const blockingReasons = compactStrings([
    ...(input.actionClass === 'serve_readonly' && !servingHealthy(input.statusInput)
      ? ['jangar_serving_dependencies_not_healthy']
      : []),
    ...(input.actionClass !== 'serve_readonly' && !input.warrant.fresh ? ['route_warrant_not_current'] : []),
    ...input.warrant.blockingReasons,
    ...(input.actionClass === 'repair' &&
    (input.warrant.repairPacketRefs.length === 0 || input.warrant.targetValueGates.length === 0)
      ? ['route_warrant_repair_packet_unscoped']
      : []),
    ...(input.actionClass !== 'serve_readonly' &&
    input.actionClass !== 'observe' &&
    input.actionClass !== 'repair' &&
    input.warrant.routeableCandidateCount <= 0
      ? ['routeable_candidate_count_zero']
      : []),
    ...(input.actionClass === 'live' && input.warrant.capitalGateSafety !== 'pass'
      ? ['capital_gate_safety_not_pass']
      : []),
    ...(input.actionClass === 'live' && input.warrant.maxNotional <= 0 ? ['max_notional_not_positive'] : []),
  ])
  const blockingDependencies = compactStrings([
    ...input.warrant.blockingDependencies,
    ...blockingReasons.map(dependencyNameForReason),
  ])
  const sourceReceipt = input.statusInput.sourceRolloutTruthExchange.receipts.find(
    (receipt) =>
      (input.actionClass === 'deploy_widen' && receipt.action_class === 'deploy_widen') ||
      (input.actionClass === 'merge_ready' && receipt.action_class === 'merge_ready') ||
      (input.actionClass === 'paper' && receipt.action_class === 'paper_canary') ||
      (input.actionClass === 'live' && receipt.action_class === 'live_micro_canary') ||
      (input.actionClass === 'repair' && receipt.action_class === 'dispatch_repair') ||
      (input.actionClass === 'implement' && receipt.action_class === 'dispatch_normal') ||
      (input.actionClass === 'serve_readonly' && receipt.action_class === 'serve_readonly') ||
      (input.actionClass === 'observe' && receipt.action_class === 'torghut_observe'),
  )
  const evidenceRefs = compactStrings([
    DEPENDENCY_VERDICT_DESIGN_ARTIFACT,
    input.statusInput.torghutConsumerEvidence.receipt_id,
    input.warrant.ref,
    ...input.warrant.repairPacketRefs,
    input.statusInput.sourceRolloutTruthExchange.exchange_id,
    sourceReceipt?.receipt_id,
    input.statusInput.controllerWitness.quorum_id,
    input.executionTrustRef,
    input.argoHealthRef,
    `watch-reliability:${input.statusInput.watchReliability.status}:${input.statusInput.watchReliability.total_errors}`,
  ])
  const verdictId = `dependency-verdict:${input.actionClass}:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.statusInput.namespace,
    action_class: input.actionClass,
    decision,
    warrant_ref: input.warrant.ref,
    blocking_reasons: blockingReasons,
    evidence_refs: evidenceRefs,
  })}`

  return {
    schema_version: VERDICT_SCHEMA_VERSION,
    verdict_id: verdictId,
    generated_at: input.statusInput.now.toISOString(),
    fresh_until: input.freshUntil,
    repository: input.statusInput.repository ?? DEFAULT_REPOSITORY,
    branch: input.statusInput.branch ?? DEFAULT_BRANCH,
    namespace: input.statusInput.namespace,
    swarm_name: input.statusInput.swarmName ?? DEFAULT_SWARM_NAME,
    stage: actionStage(input.actionClass),
    action_class: input.actionClass,
    decision,
    allowed_scope: allowedScope(input.actionClass, decision),
    max_dispatches: caps.maxDispatches,
    max_runtime_seconds: caps.maxRuntimeSeconds,
    max_notional: caps.maxNotional,
    execution_trust_ref: input.executionTrustRef,
    source_rollout_ref: input.statusInput.sourceRolloutTruthExchange.exchange_id,
    argo_health_ref: input.argoHealthRef,
    controller_watch_ref: input.statusInput.controllerWitness.quorum_id,
    torghut_route_warrant_ref: input.warrant.ref,
    torghut_repair_packet_refs: input.warrant.repairPacketRefs,
    blocking_dependency_names: blockingDependencies,
    blocking_reason_codes: blockingReasons,
    required_validation_commands: requiredValidationCommands(input.actionClass),
    evidence_refs: evidenceRefs,
    rollback_gate:
      'disable dependency-verdict enforcement and keep Torghut paper/live blocked by Torghut capital gates',
  } satisfies DependencyVerdict
}

export const dependencyVerdictForActionSloClass = (actionClass: string): DependencyVerdictActionClass | null => {
  if (actionClass === 'serve_readonly') return 'serve_readonly'
  if (actionClass === 'dispatch_repair') return 'repair'
  if (actionClass === 'dispatch_normal') return 'implement'
  if (actionClass === 'deploy_widen') return 'deploy_widen'
  if (actionClass === 'merge_ready') return 'merge_ready'
  if (actionClass === 'torghut_observe') return 'observe'
  if (actionClass === 'paper_canary') return 'paper'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'live'
  return null
}

export const buildDependencyVerdictExchange = (input: DependencyVerdictInput): DependencyVerdictExchange => {
  const warrant = resolveWarrantState(input)
  const fallbackFreshUntil = new Date(input.now.getTime() + 60_000).toISOString()
  const freshUntil = minIsoTimestamp(
    [
      warrant.freshUntil,
      input.sourceRolloutTruthExchange.fresh_until,
      input.controllerWitness.expires_at,
      fallbackFreshUntil,
    ],
    fallbackFreshUntil,
  )
  const execRef = executionTrustRef(input.executionTrust)
  const rolloutRef = argoHealthRef(input.rolloutHealth)
  const verdicts = ACTION_CLASSES.map((actionClass) =>
    buildVerdict({
      statusInput: input,
      warrant,
      actionClass,
      freshUntil,
      executionTrustRef: execRef,
      argoHealthRef: rolloutRef,
    }),
  )
  const verdictRefs = verdicts.map((verdict) => verdict.verdict_id)
  const status = verdicts.reduce<DependencyVerdictDecision>(
    (decision, verdict) => stricterDecision(decision, verdict.decision),
    'allow',
  )
  const exchangeId = `dependency-verdict-exchange:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    route_warrant_ref: warrant.ref,
    status,
    verdict_refs: verdictRefs,
  })}`

  return {
    mode: 'observe',
    design_artifact: DEPENDENCY_VERDICT_DESIGN_ARTIFACT,
    exchange_id: exchangeId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    status,
    torghut_route_warrant_ref: warrant.ref,
    verdict_refs: verdictRefs,
    allowed_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'allow')
      .map((verdict) => verdict.action_class),
    repair_only_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'repair_only')
      .map((verdict) => verdict.action_class),
    held_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'hold')
      .map((verdict) => verdict.action_class),
    blocked_action_classes: verdicts
      .filter((verdict) => verdict.decision === 'block')
      .map((verdict) => verdict.action_class),
    reason_codes: compactStrings(verdicts.flatMap((verdict) => verdict.blocking_reason_codes)),
    verdicts,
    rollback_target:
      'ignore dependency_verdict_exchange consumers and continue using stage clearance, action custody, and Torghut capital gates',
  }
}
