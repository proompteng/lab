import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionVerdictDecision,
  RuntimeKitStatus,
  SourceRolloutTruthActionDecision,
  SourceRolloutTruthControllerHeartbeatRef,
  SourceRolloutTruthExchange,
  SourceRolloutTruthImageRef,
  SourceRolloutTruthProofFloor,
  SourceRolloutTruthRouteStatus,
  SourceRolloutTruthSettlementReceipt,
  SourceRolloutTruthSettlementState,
} from '~/server/control-plane-status-types'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'
import type {
  FailureDomainKubernetesEvidence,
  FailureDomainRouteProbe,
} from '~/server/control-plane-failure-domain-leases'

export const SOURCE_ROLLOUT_TRUTH_EXCHANGE_DESIGN_ARTIFACT =
  'docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md'

const PRODUCER_REVISION = '2026-05-07-source-rollout-truth-exchange-shadow-v1'
const DEFAULT_FRESHNESS_MS = 60_000
const IMAGE_DIGEST_PATTERN = /sha256:[a-f0-9]{64}/i

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

type EnvSource = Record<string, string | undefined>

export type SourceRolloutTruthEnvironment = {
  sourceHeadSha: string | null
  gitopsRevision: string | null
}

export type SourceRolloutTruthExchangeInput = {
  now: Date
  namespace: string
  service: string
  sourceHeadSha?: string | null
  gitopsRevision?: string | null
  runtimeKits: RuntimeKitStatus[]
  kubernetesEvidence: FailureDomainKubernetesEvidence
  controllerWitness: ControlPlaneControllerWitnessQuorum
  routeProbe: FailureDomainRouteProbe
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  rolloutHealth: ControlPlaneRolloutHealth
  actionSloBudgets: ActionSloBudget[]
  torghutActionSloBudgets: ActionSloBudget[]
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addMs = (value: Date, ms: number) => new Date(value.getTime() + ms)

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const firstNonEmpty = (values: Array<string | undefined | null>) => {
  for (const value of values) {
    const normalized = normalizeNonEmpty(value)
    if (normalized) return normalized
  }
  return null
}

export const resolveSourceRolloutTruthEnvironment = (env: EnvSource = process.env): SourceRolloutTruthEnvironment => ({
  sourceHeadSha: firstNonEmpty([
    env.JANGAR_SOURCE_HEAD_SHA,
    env.JANGAR_COMMIT,
    env.SOURCE_HEAD_SHA,
    env.GIT_COMMIT,
    env.COMMIT_SHA,
  ]),
  gitopsRevision: firstNonEmpty([
    env.JANGAR_GITOPS_REVISION,
    env.ARGOCD_APP_REVISION,
    env.ARGOCD_REVISION,
    env.GITOPS_REVISION,
  ]),
})

const extractDigest = (value: string | null | undefined) =>
  value?.match(IMAGE_DIGEST_PATTERN)?.[0]?.toLowerCase() ?? null

const imageKey = (value: Pick<SourceRolloutTruthImageRef, 'image_ref' | 'image_digest'> | null) =>
  value?.image_digest ?? normalizeNonEmpty(value?.image_ref)?.toLowerCase() ?? ''

const commitsMatch = (left: string | null, right: string | null) => {
  const a = normalizeNonEmpty(left)?.toLowerCase()
  const b = normalizeNonEmpty(right)?.toLowerCase()
  if (!a || !b) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right)
  return timestamps.length > 0 ? new Date(timestamps[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const buildDesiredImages = (runtimeKits: RuntimeKitStatus[]): SourceRolloutTruthImageRef[] =>
  runtimeKits.map((kit) => ({
    image_id: `desired:${kit.kit_class}:${kit.runtime_kit_id}`,
    role: 'desired_runtime',
    name: kit.kit_class,
    namespace: null,
    image_ref: normalizeNonEmpty(kit.image_ref),
    image_digest: extractDigest(kit.image_ref),
    evidence_ref: kit.runtime_kit_id,
  }))

const buildLiveImages = (kubernetesEvidence: FailureDomainKubernetesEvidence): SourceRolloutTruthImageRef[] =>
  kubernetesEvidence.pods.flatMap((pod) =>
    pod.status.containerStatuses
      .filter((container) => container.ready || container.state.running)
      .map((container) => {
        const imageRef = normalizeNonEmpty(container.image)
        const imageId = normalizeNonEmpty(container.image_id)
        return {
          image_id: `live:${pod.metadata.namespace ?? 'unknown'}:${pod.metadata.name}:${container.name}`,
          role: 'live_pod' as const,
          name: `${pod.metadata.name}/${container.name}`,
          namespace: pod.metadata.namespace,
          image_ref: imageRef,
          image_digest: extractDigest(imageId) ?? extractDigest(imageRef),
          evidence_ref: `pod:${pod.metadata.namespace ?? 'unknown'}:${pod.metadata.name}:${container.name}`,
        }
      }),
  )

const buildRouteStatus = (routeProbe: FailureDomainRouteProbe): SourceRolloutTruthRouteStatus => ({
  route_status_ref: routeProbe.url
    ? `route:${routeProbe.url}:${routeProbe.status}:${routeProbe.status_code ?? 'none'}`
    : `route:${routeProbe.status}:${routeProbe.status_code ?? 'none'}`,
  status: routeProbe.status,
  reachable: routeProbe.reachable,
  url: routeProbe.url,
  status_code: routeProbe.status_code,
  observed_at: routeProbe.observed_at,
  message: routeProbe.message,
})

const buildControllerHeartbeat = (
  controllerWitness: ControlPlaneControllerWitnessQuorum,
): SourceRolloutTruthControllerHeartbeatRef => {
  const status =
    controllerWitness.decision === 'allow_with_split'
      ? 'split'
      : controllerWitness.controller_self_report_current
        ? 'fresh'
        : controllerWitness.decision === 'repair_only'
          ? 'split'
          : controllerWitness.reason_codes.includes('controller_ingestion_unknown')
            ? 'missing'
            : 'stale'

  return {
    heartbeat_ref: controllerWitness.quorum_id,
    status,
    decision: controllerWitness.decision,
    observed_at: controllerWitness.generated_at,
    fresh_until: controllerWitness.expires_at,
    message: controllerWitness.message,
    evidence_refs: controllerWitness.witness_refs,
  }
}

const buildDatabaseProjectionRef = (database: DatabaseStatus) =>
  `database:${database.status}:${database.migration_consistency.status}:${database.migration_consistency.latest_applied ?? 'none'}`

const buildWatchCacheRef = (watchReliability: ControlPlaneWatchReliability) =>
  `watch:${watchReliability.status}:${watchReliability.observed_streams}:${watchReliability.total_events}:${
    watchReliability.total_errors
  }:${watchReliability.total_restarts}`

const buildProofFloor = (input: {
  now: Date
  torghutActionSloBudgets: ActionSloBudget[]
  empiricalServicesHealthy: boolean
}): SourceRolloutTruthProofFloor => {
  const capitalBudgets = input.torghutActionSloBudgets.filter(
    (budget) =>
      budget.action_class === 'paper_canary' ||
      budget.action_class === 'live_micro_canary' ||
      budget.action_class === 'live_scale',
  )
  const fallbackFreshUntil = addMs(input.now, DEFAULT_FRESHNESS_MS).toISOString()

  if (capitalBudgets.length === 0) {
    return {
      proof_floor_ref: 'torghut-proof-floor:missing',
      state: 'missing',
      capital_state: 'unknown',
      fresh_until: fallbackFreshUntil,
      blockers: ['torghut_proof_floor_evidence_missing'],
      evidence_refs: ['torghut:proof_floor:missing'],
    }
  }

  const blockers = uniqueStrings(
    capitalBudgets.flatMap((budget) => [
      ...budget.blocked_reasons,
      ...budget.downgrade_reasons,
      ...(budget.decision === 'allow' ? [] : [`torghut_capital_${budget.action_class}_${budget.decision}`]),
    ]),
  )
  const evidenceRefs = uniqueStrings(capitalBudgets.flatMap((budget) => [budget.budget_id, ...budget.evidence_refs]))
  const freshUntil = minIsoTimestamp(
    capitalBudgets.map((budget) => budget.fresh_until),
    fallbackFreshUntil,
  )

  if (blockers.length > 0 || !input.empiricalServicesHealthy) {
    return {
      proof_floor_ref: `torghut-proof-floor:repair_only:${hashJson({ blockers, evidence_refs: evidenceRefs })}`,
      state: 'repair_only',
      capital_state: 'zero_notional',
      fresh_until: freshUntil,
      blockers: blockers.length > 0 ? blockers : ['torghut_empirical_services_not_authoritative'],
      evidence_refs: evidenceRefs,
    }
  }

  const liveOpen = capitalBudgets.some(
    (budget) =>
      (budget.action_class === 'live_micro_canary' || budget.action_class === 'live_scale') &&
      budget.decision === 'allow',
  )
  return {
    proof_floor_ref: `torghut-proof-floor:closed:${hashJson({
      budgets: capitalBudgets.map((budget) => budget.budget_id).sort(),
    })}`,
    state: 'closed',
    capital_state: liveOpen ? 'live' : 'paper',
    fresh_until: freshUntil,
    blockers: [],
    evidence_refs: evidenceRefs,
  }
}

const desiredImageForAction = (actionClass: ActionSloBudgetActionClass, images: SourceRolloutTruthImageRef[]) => {
  const preferredName =
    actionClass === 'dispatch_repair' || actionClass === 'dispatch_normal' ? 'collaboration' : 'serving'
  return images.find((image) => image.name === preferredName) ?? images[0] ?? null
}

const matchingLiveImage = (
  desiredImage: SourceRolloutTruthImageRef | null,
  liveImages: SourceRolloutTruthImageRef[],
) => {
  const desiredKey = imageKey(desiredImage)
  if (desiredKey.length > 0) {
    const match = liveImages.find((image) => imageKey(image) === desiredKey)
    if (match) return match
  }
  return liveImages[0] ?? null
}

const isControllerFresh = (heartbeat: SourceRolloutTruthControllerHeartbeatRef) =>
  heartbeat.status === 'fresh' && (heartbeat.decision === 'allow' || heartbeat.decision === 'allow_with_split')

const stateRank: Record<SourceRolloutTruthSettlementState, number> = {
  converged: 0,
  proof_floor_repair_only: 1,
  consumer_evidence_missing: 2,
  rollout_lagging_source: 3,
  heartbeat_projection_split: 4,
  unknown: 5,
}

const stateFromReasons = (input: {
  actionClass: ActionSloBudgetActionClass
  sourceMissing: boolean
  sourceMismatch: boolean
  imageMissing: boolean
  imageMismatch: boolean
  heartbeatSplit: boolean
  routeHealthy: boolean
  databaseHealthy: boolean
  watchHealthy: boolean
  proofFloor: SourceRolloutTruthProofFloor
}): SourceRolloutTruthSettlementState => {
  if (
    (input.actionClass === 'paper_canary' ||
      input.actionClass === 'live_micro_canary' ||
      input.actionClass === 'live_scale') &&
    input.proofFloor.state !== 'closed'
  ) {
    return input.proofFloor.state === 'repair_only' ? 'proof_floor_repair_only' : 'consumer_evidence_missing'
  }

  const sourceSensitive =
    input.actionClass === 'dispatch_normal' ||
    input.actionClass === 'deploy_widen' ||
    input.actionClass === 'merge_ready'
  if (input.heartbeatSplit && input.actionClass !== 'serve_readonly' && input.actionClass !== 'torghut_observe') {
    return 'heartbeat_projection_split'
  }
  if (!input.routeHealthy || !input.databaseHealthy || !input.watchHealthy) return 'unknown'
  if (sourceSensitive && (input.sourceMissing || input.imageMissing)) return 'unknown'
  if (sourceSensitive && (input.sourceMismatch || input.imageMismatch)) return 'rollout_lagging_source'
  if (
    (input.actionClass === 'serve_readonly' ||
      input.actionClass === 'dispatch_repair' ||
      input.actionClass === 'torghut_observe') &&
    (input.sourceMismatch || input.imageMismatch)
  ) {
    return 'rollout_lagging_source'
  }
  return 'converged'
}

const decisionForState = (
  actionClass: ActionSloBudgetActionClass,
  state: SourceRolloutTruthSettlementState,
  health: { routeHealthy: boolean; databaseHealthy: boolean; watchHealthy: boolean; controllerFresh: boolean },
): SourceRolloutTruthActionDecision => {
  if (actionClass === 'serve_readonly') {
    return health.routeHealthy && health.databaseHealthy ? 'allow' : 'hold'
  }
  if (actionClass === 'dispatch_repair') {
    return health.routeHealthy && health.databaseHealthy && health.watchHealthy && health.controllerFresh
      ? 'allow'
      : 'hold'
  }
  if (actionClass === 'torghut_observe') {
    return health.routeHealthy && health.databaseHealthy ? 'allow' : 'hold'
  }
  if (state === 'converged') return 'allow'
  if (actionClass === 'dispatch_normal' && state === 'rollout_lagging_source') return 'repair_only'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'block'
  return 'hold'
}

const reasonsForState = (input: {
  state: SourceRolloutTruthSettlementState
  sourceMissing: boolean
  sourceMismatch: boolean
  imageMissing: boolean
  imageMismatch: boolean
  heartbeat: SourceRolloutTruthControllerHeartbeatRef
  routeHealthy: boolean
  databaseHealthy: boolean
  watchHealthy: boolean
  proofFloor: SourceRolloutTruthProofFloor
}) => {
  const reasons: string[] = []
  if (input.sourceMissing) reasons.push('source_rollout_truth_missing:source_or_gitops_revision')
  if (input.sourceMismatch) reasons.push('source_head_gitops_revision_mismatch')
  if (input.imageMissing) reasons.push('source_rollout_truth_missing:desired_or_live_image')
  if (input.imageMismatch) reasons.push('desired_live_image_mismatch')
  if (input.state === 'heartbeat_projection_split') {
    reasons.push(...(input.heartbeat.decision === 'allow' ? [] : input.heartbeat.evidence_refs))
    reasons.push(...(input.heartbeat.status === 'fresh' ? [] : ['controller_heartbeat_not_current']))
  }
  if (!input.routeHealthy) reasons.push('route_status_not_healthy')
  if (!input.databaseHealthy) reasons.push('database_projection_not_healthy')
  if (!input.watchHealthy) reasons.push('watch_cache_not_healthy')
  if (input.state === 'proof_floor_repair_only' || input.state === 'consumer_evidence_missing') {
    reasons.push(...input.proofFloor.blockers)
  }
  if (input.state === 'unknown' && reasons.length === 0) reasons.push('source_rollout_truth_unknown')
  return uniqueStrings(reasons)
}

const rollbackTargetForState = (input: {
  state: SourceRolloutTruthSettlementState
  decision: SourceRolloutTruthActionDecision
  controllerWitness: ControlPlaneControllerWitnessQuorum
}) => {
  if (input.decision === 'allow' || input.decision === 'observe_only') return null
  if (input.state === 'rollout_lagging_source') {
    return 'hold rollout widening until GitOps revision, desired image, and live image converge'
  }
  if (input.state === 'heartbeat_projection_split') {
    return (
      input.controllerWitness.rollback_target ?? 'hold material dispatch until controller heartbeat authority settles'
    )
  }
  if (input.state === 'proof_floor_repair_only' || input.state === 'consumer_evidence_missing') {
    return 'keep Torghut capital zero-notional until proof-floor settlement closes'
  }
  return 'keep source-rollout truth exchange in shadow and hold material widening until inputs are readable'
}

const mapTruthDecisionToVerdictDecision = (
  decision: SourceRolloutTruthActionDecision,
): MaterialActionVerdictDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'repair_only' || decision === 'observe_only') return 'repair_only'
  if (decision === 'block') return 'block'
  return 'hold'
}

export const sourceRolloutTruthVerdictDecision = mapTruthDecisionToVerdictDecision

const buildReceipt = (input: {
  now: Date
  sourceHeadSha: string | null
  gitopsRevision: string | null
  desiredImage: SourceRolloutTruthImageRef | null
  liveImage: SourceRolloutTruthImageRef | null
  actionClass: ActionSloBudgetActionClass
  heartbeat: SourceRolloutTruthControllerHeartbeatRef
  databaseProjectionRef: string
  watchCacheRef: string
  routeStatus: SourceRolloutTruthRouteStatus
  proofFloor: SourceRolloutTruthProofFloor
  budget: ActionSloBudget | undefined
  controllerWitness: ControlPlaneControllerWitnessQuorum
}): SourceRolloutTruthSettlementReceipt => {
  const sourceMissing = !input.sourceHeadSha || !input.gitopsRevision
  const sourceMismatch = Boolean(
    input.sourceHeadSha && input.gitopsRevision && !commitsMatch(input.sourceHeadSha, input.gitopsRevision),
  )
  const imageMissing = !input.desiredImage || !input.liveImage || imageKey(input.desiredImage).length === 0
  const imageMismatch = Boolean(
    input.desiredImage &&
    input.liveImage &&
    imageKey(input.desiredImage) &&
    imageKey(input.desiredImage) !== imageKey(input.liveImage),
  )
  const routeHealthy = input.routeStatus.status === 'healthy' && input.routeStatus.reachable
  const databaseHealthy = input.databaseProjectionRef.startsWith('database:healthy:healthy')
  const watchHealthy = input.watchCacheRef.startsWith('watch:healthy:')
  const controllerFresh = isControllerFresh(input.heartbeat)
  const heartbeatSplit = !controllerFresh
  const settlementState = stateFromReasons({
    actionClass: input.actionClass,
    sourceMissing,
    sourceMismatch,
    imageMissing,
    imageMismatch,
    heartbeatSplit,
    routeHealthy,
    databaseHealthy,
    watchHealthy,
    proofFloor: input.proofFloor,
  })
  const actionDecision = decisionForState(input.actionClass, settlementState, {
    routeHealthy,
    databaseHealthy,
    watchHealthy,
    controllerFresh,
  })
  const allReasons = reasonsForState({
    state: settlementState,
    sourceMissing,
    sourceMismatch,
    imageMissing,
    imageMismatch,
    heartbeat: input.heartbeat,
    routeHealthy,
    databaseHealthy,
    watchHealthy,
    proofFloor: input.proofFloor,
  })
  const blockingReasons = actionDecision === 'allow' || actionDecision === 'observe_only' ? [] : allReasons
  const freshUntil = minIsoTimestamp(
    [input.heartbeat.fresh_until, input.proofFloor.fresh_until, input.budget?.fresh_until],
    addMs(input.now, DEFAULT_FRESHNESS_MS).toISOString(),
  )
  const receiptId = `truth-settlement:${input.actionClass}:${hashJson({
    source_head_sha: input.sourceHeadSha,
    gitops_revision: input.gitopsRevision,
    desired_image: imageKey(input.desiredImage),
    live_image: imageKey(input.liveImage),
    controller_heartbeat_ref: input.heartbeat.heartbeat_ref,
    database_projection_ref: input.databaseProjectionRef,
    watch_cache_ref: input.watchCacheRef,
    route_status_ref: input.routeStatus.route_status_ref,
    torghut_proof_floor_ref: input.proofFloor.proof_floor_ref,
    settlement_state: settlementState,
    action_decision: actionDecision,
    blocking_reasons: blockingReasons,
  })}`

  return {
    receipt_id: receiptId,
    action_class: input.actionClass,
    settlement_state: settlementState,
    source_head_sha: input.sourceHeadSha,
    gitops_revision: input.gitopsRevision,
    desired_image_ref: input.desiredImage?.image_ref ?? null,
    desired_image_digest: input.desiredImage?.image_digest ?? null,
    live_image_ref: input.liveImage?.image_ref ?? null,
    live_image_digest: input.liveImage?.image_digest ?? null,
    controller_heartbeat_ref: input.heartbeat.heartbeat_ref,
    database_projection_ref: input.databaseProjectionRef,
    watch_cache_ref: input.watchCacheRef,
    route_status_ref: input.routeStatus.route_status_ref,
    torghut_proof_floor_ref: input.proofFloor.proof_floor_ref,
    fresh_until: freshUntil,
    action_decision: actionDecision,
    blocking_reasons: blockingReasons,
    rollback_target: rollbackTargetForState({
      state: settlementState,
      decision: actionDecision,
      controllerWitness: input.controllerWitness,
    }),
  }
}

const buildDeployerSummary = (
  receipts: SourceRolloutTruthSettlementReceipt[],
): SourceRolloutTruthExchange['deployer_summary'] => {
  const heldReceipts = receipts.filter(
    (receipt) =>
      receipt.action_decision === 'repair_only' ||
      receipt.action_decision === 'hold' ||
      receipt.action_decision === 'block',
  )
  const freshestBlocked = [...heldReceipts]
    .filter((receipt) => receipt.blocking_reasons.length > 0)
    .sort((left, right) => Date.parse(right.fresh_until) - Date.parse(left.fresh_until))[0]
  const worstState = receipts.reduce<SourceRolloutTruthSettlementState>(
    (current, receipt) =>
      stateRank[receipt.settlement_state] > stateRank[current] ? receipt.settlement_state : current,
    'converged',
  )

  return {
    settlement_state: worstState,
    freshest_blocking_reason: freshestBlocked?.blocking_reasons[0] ?? null,
    rollback_target:
      freshestBlocked?.rollback_target ??
      heldReceipts.find((receipt) => receipt.rollback_target)?.rollback_target ??
      null,
    held_action_classes: heldReceipts.map((receipt) => receipt.action_class),
    receipt_refs: receipts.map((receipt) => receipt.receipt_id),
  }
}

export const buildSourceRolloutTruthExchange = (input: SourceRolloutTruthExchangeInput): SourceRolloutTruthExchange => {
  const desiredImages = buildDesiredImages(input.runtimeKits)
  const liveImages = buildLiveImages(input.kubernetesEvidence)
  const heartbeat = buildControllerHeartbeat(input.controllerWitness)
  const routeStatus = buildRouteStatus(input.routeProbe)
  const databaseProjectionRef = buildDatabaseProjectionRef(input.database)
  const watchCacheRef = buildWatchCacheRef(input.watchReliability)
  const budgetByAction = new Map(input.actionSloBudgets.map((budget) => [budget.action_class, budget]))
  const proofFloor = buildProofFloor({
    now: input.now,
    torghutActionSloBudgets: input.torghutActionSloBudgets,
    empiricalServicesHealthy: true,
  })
  const actionClasses = uniqueStrings([
    ...ACTION_CLASSES,
    ...input.actionSloBudgets.map((budget) => budget.action_class),
  ]).filter((value): value is ActionSloBudgetActionClass => (ACTION_CLASSES as string[]).includes(value))

  const sourceHeadSha = normalizeNonEmpty(input.sourceHeadSha)
  const gitopsRevision = normalizeNonEmpty(input.gitopsRevision)
  const receipts = actionClasses.map((actionClass) => {
    const desiredImage = desiredImageForAction(actionClass, desiredImages)
    return buildReceipt({
      now: input.now,
      sourceHeadSha,
      gitopsRevision,
      desiredImage,
      liveImage: matchingLiveImage(desiredImage, liveImages),
      actionClass,
      heartbeat,
      databaseProjectionRef,
      watchCacheRef,
      routeStatus,
      proofFloor,
      budget: budgetByAction.get(actionClass),
      controllerWitness: input.controllerWitness,
    })
  })
  const freshUntil = minIsoTimestamp(
    receipts.map((receipt) => receipt.fresh_until),
    addMs(input.now, DEFAULT_FRESHNESS_MS).toISOString(),
  )
  const deployerSummary = buildDeployerSummary(receipts)
  const exchangeId = `source-rollout-truth-exchange:${hashJson({
    namespace: input.namespace,
    service: input.service,
    producer_revision: PRODUCER_REVISION,
    receipt_refs: receipts.map((receipt) => receipt.receipt_id).sort(),
  })}`

  return {
    mode: 'shadow',
    design_artifact: SOURCE_ROLLOUT_TRUTH_EXCHANGE_DESIGN_ARTIFACT,
    exchange_id: exchangeId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    source_head_sha: sourceHeadSha,
    gitops_revision: gitopsRevision,
    desired_images: desiredImages,
    live_images: liveImages,
    controller_heartbeats: [heartbeat],
    route_statuses: [routeStatus],
    database_projection_ref: databaseProjectionRef,
    watch_cache_ref: watchCacheRef,
    torghut_proof_floor: proofFloor,
    receipts,
    deployer_summary: deployerSummary,
    rollback_target: deployerSummary.rollback_target,
  }
}
