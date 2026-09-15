import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionActivationReceiptDecision,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  RouteStabilityEscrow,
  RouteStabilityLiveRouteAttempt,
  RouteStabilityMaterialActionContract,
  RouteStabilityWindow,
} from '~/server/control-plane-status-types'
import type { FailureDomainRouteProbe } from '~/server/control-plane-failure-domain-leases'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const ROUTE_STABILITY_ESCROW_DESIGN_ARTIFACT =
  'docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md'

const PRODUCER_REVISION = '2026-05-07-route-stability-escrow-shadow-v1'
const DEFAULT_SNAPSHOT_FRESHNESS_MS = 5 * 60 * 1000
const ROUTE_STABILITY_WINDOW_MS = 60 * 1000
const REQUIRED_LIVE_ROUTE_SUCCESSES = 1

const ACTION_CLASSES: ActionSloBudgetActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

const DECISION_RANK: Record<MaterialActionActivationReceiptDecision, number> = {
  allow: 0,
  observe_only: 1,
  repair_only: 2,
  hold: 3,
  block: 4,
}

type RouteStabilityDecisionInput = {
  actionClass: ActionSloBudgetActionClass
  snapshotFresh: boolean
  liveRouteHealthy: boolean
  controllerSelfReportCurrent: boolean
  databaseHealthy: boolean
  rolloutHealthy: boolean
}

export type RouteStabilityEscrowInput = {
  now: Date
  namespace: string
  service: string
  routeProbe: FailureDomainRouteProbe
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  watchReliability: ControlPlaneWatchReliability
  controllerWitness: ControlPlaneControllerWitnessQuorum
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const addMilliseconds = (date: Date, milliseconds: number) => new Date(date.getTime() + milliseconds)

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

const routeAttemptResult = (routeProbe: FailureDomainRouteProbe): RouteStabilityLiveRouteAttempt['result'] => {
  if (routeProbe.status === 'healthy' && routeProbe.reachable) return 'success'
  if (routeProbe.status === 'unknown') return 'unknown'
  return 'failure'
}

const buildRouteAttempt = (routeProbe: FailureDomainRouteProbe): RouteStabilityLiveRouteAttempt => ({
  attempt_id: `route-attempt:${hashJson({
    url: routeProbe.url,
    result: routeAttemptResult(routeProbe),
    status_code: routeProbe.status_code,
    observed_at: routeProbe.observed_at,
    message: routeProbe.message,
  })}`,
  attempted_at: routeProbe.observed_at,
  url: routeProbe.url,
  result: routeAttemptResult(routeProbe),
  status_code: routeProbe.status_code,
  latency_ms: routeProbe.latency_ms,
  message: routeProbe.message,
})

const controllerAuthorityMode = (
  controllerWitness: ControlPlaneControllerWitnessQuorum,
): RouteStabilityWindow['controller_authority_mode'] => {
  if (controllerWitness.controller_self_report_current) {
    const controllerProcess = controllerWitness.witnesses.find(
      (witness) => witness.controller_surface === 'controller_process' && witness.decision === 'allow',
    )
    if (controllerProcess) return 'heartbeat'

    const servingProcess = controllerWitness.witnesses.find(
      (witness) => witness.controller_surface === 'serving_process' && witness.decision === 'allow',
    )
    if (servingProcess) return 'serving_process'
  }

  if (controllerWitness.deployment_available && controllerWitness.watch_epoch_current) return 'rollout'
  return 'unknown'
}

const baseDecisionFromVerdict = (
  verdict: MaterialActionVerdict | undefined,
): MaterialActionActivationReceiptDecision => {
  if (!verdict) return 'hold'
  if (verdict.decision === 'allow') return 'allow'
  if (verdict.decision === 'repair_only') return 'repair_only'
  if (verdict.decision === 'block') return 'block'
  return 'hold'
}

const stricterDecision = (
  left: MaterialActionActivationReceiptDecision,
  right: MaterialActionActivationReceiptDecision,
) => (DECISION_RANK[left] >= DECISION_RANK[right] ? left : right)

const routeRequirementForAction = (
  actionClass: ActionSloBudgetActionClass,
): RouteStabilityMaterialActionContract['route_requirement'] => {
  if (actionClass === 'serve_readonly') return 'none'
  if (actionClass === 'dispatch_repair' || actionClass === 'torghut_observe') return 'escrow_allowed'
  return 'live_required'
}

const controllerRequirementForAction = (
  actionClass: ActionSloBudgetActionClass,
): RouteStabilityMaterialActionContract['controller_requirement'] => {
  if (actionClass === 'dispatch_repair') return 'rollout_ok_for_repair'
  if (
    actionClass === 'dispatch_normal' ||
    actionClass === 'deploy_widen' ||
    actionClass === 'merge_ready' ||
    actionClass === 'paper_canary' ||
    actionClass === 'live_micro_canary' ||
    actionClass === 'live_scale'
  ) {
    return 'heartbeat_required'
  }
  return 'none'
}

const routeReasonCodes = (routeProbe: FailureDomainRouteProbe) => {
  if (routeProbe.status === 'healthy' && routeProbe.reachable) return []
  if (routeProbe.status === 'unknown') return ['live_status_route_unknown']
  if (routeProbe.status_code !== null) return [`live_status_route_http_${routeProbe.status_code}`]
  return ['live_status_route_unreachable']
}

const routeDecisionForAction = ({
  actionClass,
  snapshotFresh,
  liveRouteHealthy,
  controllerSelfReportCurrent,
  databaseHealthy,
  rolloutHealthy,
}: RouteStabilityDecisionInput): MaterialActionActivationReceiptDecision => {
  if (actionClass === 'serve_readonly') return 'allow'

  if (!snapshotFresh && !liveRouteHealthy) {
    return actionClass === 'live_scale' ? 'block' : 'hold'
  }

  if (actionClass === 'dispatch_repair' || actionClass === 'torghut_observe') {
    return snapshotFresh || liveRouteHealthy ? 'allow' : 'hold'
  }

  if (!liveRouteHealthy) {
    if (actionClass === 'dispatch_normal' && snapshotFresh) return 'repair_only'
    return actionClass === 'live_scale' ? 'block' : 'hold'
  }

  if (!controllerSelfReportCurrent) {
    if (actionClass === 'dispatch_normal') return 'repair_only'
    return actionClass === 'live_scale' ? 'block' : 'hold'
  }

  if ((actionClass === 'deploy_widen' || actionClass === 'merge_ready') && (!databaseHealthy || !rolloutHealthy)) {
    return 'hold'
  }

  return 'allow'
}

const boundedDispatches = (
  decision: MaterialActionActivationReceiptDecision,
  baseValue: number | null,
  actionClass: ActionSloBudgetActionClass,
) => {
  if (decision === 'hold' || decision === 'block') return 0
  if (decision === 'repair_only' && actionClass === 'dispatch_normal') return 1
  return baseValue
}

const boundedRuntimeSeconds = (
  decision: MaterialActionActivationReceiptDecision,
  baseValue: number | null,
  actionClass: ActionSloBudgetActionClass,
) => {
  if (decision === 'hold' || decision === 'block') return 0
  if (decision === 'repair_only' && actionClass === 'dispatch_normal') return 20 * 60
  return baseValue
}

const boundedNotional = (
  decision: MaterialActionActivationReceiptDecision,
  baseValue: number | null,
  actionClass: ActionSloBudgetActionClass,
  liveRouteHealthy: boolean,
) => {
  if (decision !== 'allow') return 0
  if (!liveRouteHealthy && (actionClass === 'dispatch_repair' || actionClass === 'torghut_observe')) return 0
  return baseValue ?? 0
}

const buildRequiredRepairs = (input: {
  baseRepairs: string[]
  decision: MaterialActionActivationReceiptDecision
  routeProbe: FailureDomainRouteProbe
  snapshotFresh: boolean
  controllerSelfReportCurrent: boolean
  databaseHealthy: boolean
  rolloutHealthy: boolean
}) =>
  uniqueStrings([
    ...input.baseRepairs,
    ...(!input.snapshotFresh ? ['refresh route-stability status snapshot'] : []),
    ...routeReasonCodes(input.routeProbe).map((reason) => `restore live status route: ${reason}`),
    ...(!input.controllerSelfReportCurrent ? ['publish a fresh controller-process witness'] : []),
    ...(!input.databaseHealthy ? ['restore database projection before material action'] : []),
    ...(!input.rolloutHealthy ? ['restore rollout health before material action'] : []),
    ...(input.decision === 'block' ? ['keep live capital blocked until route-stability authority is current'] : []),
  ])

const buildMaterialActionContract = (input: {
  actionClass: ActionSloBudgetActionClass
  verdict: MaterialActionVerdict | undefined
  snapshotRef: string
  liveRouteRef: string | null
  routeProbe: FailureDomainRouteProbe
  snapshotFresh: boolean
  liveRouteHealthy: boolean
  controllerSelfReportCurrent: boolean
  databaseHealthy: boolean
  rolloutHealthy: boolean
}): RouteStabilityMaterialActionContract => {
  const baseDecision = baseDecisionFromVerdict(input.verdict)
  const routeDecision = routeDecisionForAction({
    actionClass: input.actionClass,
    snapshotFresh: input.snapshotFresh,
    liveRouteHealthy: input.liveRouteHealthy,
    controllerSelfReportCurrent: input.controllerSelfReportCurrent,
    databaseHealthy: input.databaseHealthy,
    rolloutHealthy: input.rolloutHealthy,
  })
  const decision = stricterDecision(baseDecision, routeDecision)
  const requiredRepairs = buildRequiredRepairs({
    baseRepairs: input.verdict?.required_repair_actions ?? [],
    decision,
    routeProbe: input.routeProbe,
    snapshotFresh: input.snapshotFresh,
    controllerSelfReportCurrent: input.controllerSelfReportCurrent,
    databaseHealthy: input.databaseHealthy,
    rolloutHealthy: input.rolloutHealthy,
  })

  return {
    action_class: input.actionClass,
    route_requirement: routeRequirementForAction(input.actionClass),
    controller_requirement: controllerRequirementForAction(input.actionClass),
    decision,
    max_dispatches: boundedDispatches(decision, input.verdict?.max_dispatches ?? null, input.actionClass),
    max_runtime_seconds: boundedRuntimeSeconds(decision, input.verdict?.max_runtime_seconds ?? null, input.actionClass),
    max_notional: boundedNotional(
      decision,
      input.verdict?.max_notional ?? null,
      input.actionClass,
      input.liveRouteHealthy,
    ),
    required_repairs: requiredRepairs,
    snapshot_ref: input.snapshotRef,
    live_route_ref: input.liveRouteRef,
    rollback_target:
      input.verdict?.rollback_target ??
      (decision === 'allow'
        ? null
        : 'keep route-stability escrow in shadow and hold material action until live route authority recovers'),
  }
}

const statusSnapshotHash = (input: RouteStabilityEscrowInput) =>
  hashJson({
    namespace: input.namespace,
    service: input.service,
    producer_revision: PRODUCER_REVISION,
    controller_witness_ref: input.controllerWitness.quorum_id,
    material_action_verdict_epoch: input.materialActionVerdictEpoch.epoch_id,
    database: {
      status: input.database.status,
      migration_consistency: input.database.migration_consistency.status,
      latest_registered: input.database.migration_consistency.latest_registered,
      latest_applied: input.database.migration_consistency.latest_applied,
    },
    watch_reliability: {
      status: input.watchReliability.status,
      total_errors: input.watchReliability.total_errors,
      total_restarts: input.watchReliability.total_restarts,
    },
    rollout_health: {
      status: input.rolloutHealth.status,
      observed_deployments: input.rolloutHealth.observed_deployments,
      degraded_deployments: input.rolloutHealth.degraded_deployments,
    },
  })

const windowState = (input: {
  liveRouteHealthy: boolean
  snapshotFresh: boolean
  controllerSelfReportCurrent: boolean
  routeProbe: FailureDomainRouteProbe
  controllerWitness: ControlPlaneControllerWitnessQuorum
}): RouteStabilityWindow['state'] => {
  if (input.liveRouteHealthy && input.controllerSelfReportCurrent) return 'stable'
  if (
    input.snapshotFresh &&
    input.controllerWitness.deployment_available &&
    input.controllerWitness.watch_epoch_current
  ) {
    return 'escrow_repair_only'
  }
  if (input.routeProbe.status === 'unknown') return 'unknown'
  return 'unstable'
}

const buildWindow = (input: {
  now: Date
  freshUntil: string
  liveRouteHealthy: boolean
  snapshotFresh: boolean
  routeProbe: FailureDomainRouteProbe
  controllerWitness: ControlPlaneControllerWitnessQuorum
  contracts: RouteStabilityMaterialActionContract[]
}): RouteStabilityWindow => {
  const controllerMode = controllerAuthorityMode(input.controllerWitness)
  const state = windowState({
    liveRouteHealthy: input.liveRouteHealthy,
    snapshotFresh: input.snapshotFresh,
    controllerSelfReportCurrent: input.controllerWitness.controller_self_report_current,
    routeProbe: input.routeProbe,
    controllerWitness: input.controllerWitness,
  })
  const allowedActionClasses = input.contracts
    .filter((contract) => contract.decision === 'allow' || contract.decision === 'observe_only')
    .map((contract) => contract.action_class)
  const heldActionClasses = input.contracts
    .filter((contract) => contract.decision === 'repair_only' || contract.decision === 'hold')
    .map((contract) => contract.action_class)
  const blockedActionClasses = input.contracts
    .filter((contract) => contract.decision === 'block')
    .map((contract) => contract.action_class)
  const reasonCodes = uniqueStrings([
    ...routeReasonCodes(input.routeProbe),
    ...(!input.snapshotFresh ? ['status_snapshot_expired'] : []),
    ...(!input.controllerWitness.controller_self_report_current ? input.controllerWitness.reason_codes : []),
  ])

  return {
    state,
    started_at: input.now.toISOString(),
    stable_after: input.liveRouteHealthy
      ? input.now.toISOString()
      : addMilliseconds(input.now, ROUTE_STABILITY_WINDOW_MS).toISOString(),
    expires_at: input.freshUntil,
    live_route_success_count: input.liveRouteHealthy ? 1 : 0,
    required_success_count: REQUIRED_LIVE_ROUTE_SUCCESSES,
    controller_authority_mode: controllerMode,
    allowed_action_classes: allowedActionClasses,
    held_action_classes: heldActionClasses,
    blocked_action_classes: blockedActionClasses,
    reason_codes: reasonCodes,
  }
}

export const buildRouteStabilityEscrow = (input: RouteStabilityEscrowInput): RouteStabilityEscrow => {
  const fallbackFreshUntil = addMilliseconds(input.now, DEFAULT_SNAPSHOT_FRESHNESS_MS).toISOString()
  const freshUntil = minIsoTimestamp(
    [input.materialActionVerdictEpoch.expires_at, input.controllerWitness.expires_at, fallbackFreshUntil],
    fallbackFreshUntil,
  )
  const snapshotFresh = (parseIso(freshUntil) ?? 0) > input.now.getTime()
  const routeAttempt = buildRouteAttempt(input.routeProbe)
  const liveRouteHealthy = routeAttempt.result === 'success'
  const snapshotHash = statusSnapshotHash(input)
  const snapshotRef = `control-plane-status:${input.namespace}:${snapshotHash}`
  const liveRouteRef = routeAttempt.result === 'success' ? routeAttempt.attempt_id : null
  const databaseHealthy =
    input.database.status === 'healthy' && input.database.migration_consistency.status === 'healthy'
  const rolloutHealthy = input.rolloutHealth.status === 'healthy'
  const verdictByAction = new Map(
    input.materialActionVerdictEpoch.final_verdicts.map((verdict) => [verdict.action_class, verdict]),
  )
  const contracts = ACTION_CLASSES.map((actionClass) =>
    buildMaterialActionContract({
      actionClass,
      verdict: verdictByAction.get(actionClass),
      snapshotRef,
      liveRouteRef,
      routeProbe: input.routeProbe,
      snapshotFresh,
      liveRouteHealthy,
      controllerSelfReportCurrent: input.controllerWitness.controller_self_report_current,
      databaseHealthy,
      rolloutHealthy,
    }),
  )
  const window = buildWindow({
    now: input.now,
    freshUntil,
    liveRouteHealthy,
    snapshotFresh,
    routeProbe: input.routeProbe,
    controllerWitness: input.controllerWitness,
    contracts,
  })
  const escrowId = `route-stability-escrow:${hashJson({
    namespace: input.namespace,
    producer_revision: PRODUCER_REVISION,
    snapshot_hash: snapshotHash,
    route_attempt_id: routeAttempt.attempt_id,
    window_state: window.state,
    contract_decisions: contracts.map((contract) => [contract.action_class, contract.decision]),
  })}`
  const databaseProjectionRef = `database:${input.database.status}:${input.database.migration_consistency.status}`
  const watchReliabilityRef = `watch:${input.watchReliability.status}:${input.watchReliability.total_events}:${
    input.watchReliability.total_errors
  }:${input.watchReliability.total_restarts}`

  return {
    mode: 'shadow',
    design_artifact: ROUTE_STABILITY_ESCROW_DESIGN_ARTIFACT,
    escrow_id: escrowId,
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    status_snapshot_ref: snapshotRef,
    status_snapshot_hash: snapshotHash,
    status_producer_revision: PRODUCER_REVISION,
    live_route_attempts: [routeAttempt],
    last_live_route_success_at: liveRouteHealthy ? routeAttempt.attempted_at : null,
    last_live_route_error: liveRouteHealthy ? null : routeAttempt.message,
    route_stability_window: window,
    controller_witness_ref: input.controllerWitness.quorum_id,
    database_projection_ref: databaseProjectionRef,
    watch_reliability_ref: watchReliabilityRef,
    material_action_contracts: contracts,
    rollback_target:
      window.state === 'stable'
        ? null
        : 'ignore route_stability_escrow consumers and continue using material action receipts in shadow',
  }
}
