import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  AuthorityProvenanceActionDecision,
  AuthorityProvenanceActionDecisionValue,
  AuthorityProvenanceReentryWindow,
  AuthorityProvenanceSettlement,
  AuthorityProvenanceSettlementMode,
  AuthorityProvenanceSettlementState,
  AuthorityProvenanceSurface,
  AuthorityProvenanceSurfaceStatus,
  AuthorityProvenanceWinningAuthority,
  ControlPlaneControllerWitnessQuorum,
  ReadyTruthArbiter,
  SourceRolloutTruthExchange,
  SourceRolloutTruthSettlementReceipt,
  SourceServingContractVerdictExchange,
  StageClearancePacket,
  StageClearanceStage,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-status-types'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
  RuntimeAdapterStatus,
} from '~/server/control-plane-status-types'

export const AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT =
  'docs/agents/designs/189-jangar-authority-provenance-settlement-and-rollout-reentry-windows-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.authority-provenance-settlement.v1' as const
const DEFAULT_TTL_SECONDS = 60
const DEFAULT_REENTRY_WINDOW_SECONDS = 15 * 60
const ROLLBACK_TARGET = 'JANGAR_AUTHORITY_PROVENANCE_SETTLEMENT_MODE=observe'

const GOVERNING_DESIGN_REFS = [
  AUTHORITY_PROVENANCE_SETTLEMENT_DESIGN_ARTIFACT,
  'docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md',
  'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

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

const CAPITAL_ACTION_CLASSES: ActionSloBudgetActionClass[] = ['paper_canary', 'live_micro_canary', 'live_scale']

const SETTLEMENT_RANK: Record<AuthorityProvenanceSettlementState, number> = {
  settled: 0,
  settled_with_split: 1,
  repairable_split: 2,
  hold: 3,
  block: 4,
}

export type AuthorityProvenanceSettlementInput = {
  now: Date
  namespace: string
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  runtimeAdapters: RuntimeAdapterStatus[]
  workflows: {
    active_job_runs: number
    recent_failed_jobs: number
    backoff_limit_exceeded_jobs: number
    data_confidence: 'high' | 'degraded' | 'unknown'
    collection_errors: number
  }
  watchReliability: ControlPlaneWatchReliability
  agentRunIngestion: AgentRunIngestionStatus
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  stageClearancePackets: StageClearancePacket[]
  actionSloBudgets: ActionSloBudget[]
  projectionWatermarks: Array<{
    projection_watermark_id: string
    status: string
    expires_at: string
    reason_codes: string[]
  }>
  stageCreditLedger: StageCreditLedger | null
  readyTruthArbiter: ReadyTruthArbiter
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

type SurfaceDraft = {
  surface: AuthorityProvenanceSurface['surface']
  authority: AuthorityProvenanceWinningAuthority
  status: AuthorityProvenanceSurfaceStatus
  settlementState: AuthorityProvenanceSettlementState
  evidenceRefs: string[]
  reasonCodes: string[]
  message: string
}

export const resolveAuthorityProvenanceSettlementMode = (
  env: NodeJS.ProcessEnv = process.env,
): AuthorityProvenanceSettlementMode => {
  const normalized = env.JANGAR_AUTHORITY_PROVENANCE_SETTLEMENT_MODE?.trim().toLowerCase()
  if (normalized === 'observe' || normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') {
    return normalized
  }
  return 'shadow'
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const parseNotional = (value: string | null | undefined) => {
  if (value == null) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

const sourceReceiptFor = (
  exchange: SourceRolloutTruthExchange,
  actionClass: ActionSloBudgetActionClass,
): SourceRolloutTruthSettlementReceipt | null =>
  exchange.receipts.find((receipt) => receipt.action_class === actionClass) ?? null

const sourceReceiptAllows = (receipt: SourceRolloutTruthSettlementReceipt | null) =>
  Boolean(receipt && receipt.action_decision === 'allow' && receipt.settlement_state === 'converged')

const decisionForReadyTruth = (
  readyTruthArbiter: ReadyTruthArbiter,
  actionClass: ActionSloBudgetActionClass,
): AuthorityProvenanceActionDecisionValue => {
  if (readyTruthArbiter.blocked_action_classes.includes(actionClass)) return 'block'
  if (readyTruthArbiter.held_action_classes.includes(actionClass)) return 'hold'
  if (readyTruthArbiter.repair_only_action_classes.includes(actionClass)) return 'repair_only'
  return 'allow'
}

const strictestSettlement = (states: AuthorityProvenanceSettlementState[]): AuthorityProvenanceSettlementState => {
  let strictest: AuthorityProvenanceSettlementState = 'settled'
  for (const state of states) {
    if (SETTLEMENT_RANK[state] > SETTLEMENT_RANK[strictest]) strictest = state
  }
  return strictest
}

const surfaceFromDraft = (input: {
  draft: SurfaceDraft
  now: Date
  freshUntil: string
}): AuthorityProvenanceSurface => ({
  surface: input.draft.surface,
  authority: input.draft.authority,
  status: input.draft.status,
  settlement_state: input.draft.settlementState,
  observed_at: input.now.toISOString(),
  fresh_until: input.freshUntil,
  evidence_refs: uniqueStrings(input.draft.evidenceRefs),
  reason_codes: uniqueStrings(input.draft.reasonCodes.map(normalizeReason)),
  message: input.draft.message,
})

const databaseSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const reasons = uniqueStrings([
    input.database.status === 'healthy' ? null : `database_${input.database.status}`,
    input.database.connected ? null : 'database_not_connected',
    input.database.migration_consistency.status === 'healthy'
      ? null
      : `database_migrations_${input.database.migration_consistency.status}`,
  ])

  if (input.database.status === 'disabled' || !input.database.connected) {
    return {
      surface: 'database_schema',
      authority: 'database_projection',
      status: 'blocked',
      settlementState: 'block',
      evidenceRefs: [`database:${input.database.status}:${input.database.migration_consistency.status}`],
      reasonCodes: reasons,
      message: input.database.message || 'database authority is unavailable',
    }
  }

  return {
    surface: 'database_schema',
    authority: 'database_projection',
    status: reasons.length === 0 ? 'current' : 'degraded',
    settlementState: reasons.length === 0 ? 'settled' : 'hold',
    evidenceRefs: [`database:${input.database.status}:${input.database.migration_consistency.status}`],
    reasonCodes: reasons,
    message: reasons.length === 0 ? 'database schema projection is current' : input.database.message,
  }
}

const controllerSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const witness = input.controllerWitness
  if (witness.decision === 'allow') {
    return {
      surface: 'controller_process',
      authority: witness.controller_self_report_current ? 'controller_heartbeat' : 'serving_process',
      status: 'current',
      settlementState: 'settled',
      evidenceRefs: [witness.quorum_id, ...witness.witness_refs],
      reasonCodes: witness.reason_codes,
      message: witness.message || 'controller authority is current',
    }
  }
  if (witness.decision === 'allow_with_split') {
    return {
      surface: 'controller_process',
      authority: 'controller_heartbeat',
      status: 'split',
      settlementState: 'settled_with_split',
      evidenceRefs: [witness.quorum_id, ...witness.witness_refs],
      reasonCodes: ['controller_process_split', ...witness.reason_codes],
      message: witness.message || 'controller heartbeat settles split serving topology',
    }
  }

  const missingHeartbeat = !witness.controller_self_report_current
  return {
    surface: 'controller_process',
    authority: missingHeartbeat ? 'none' : 'controller_heartbeat',
    status: missingHeartbeat ? 'missing' : 'held',
    settlementState: missingHeartbeat || witness.decision === 'hold_material' ? 'hold' : 'repairable_split',
    evidenceRefs: [witness.quorum_id, ...witness.witness_refs],
    reasonCodes: uniqueStrings([
      missingHeartbeat ? 'controller_heartbeat_missing' : null,
      `controller_witness_${witness.decision}`,
      ...witness.reason_codes,
    ]),
    message: witness.message || 'controller authority is not settled',
  }
}

const agentRunIngestionSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  if (input.agentRunIngestion.status === 'healthy') {
    return {
      surface: 'agentrun_ingestion',
      authority: 'controller_heartbeat',
      status: 'current',
      settlementState: 'settled',
      evidenceRefs: [`agentrun-ingestion:${input.agentRunIngestion.namespace}:healthy`],
      reasonCodes: [],
      message: input.agentRunIngestion.message || 'AgentRun ingestion is current',
    }
  }

  const splitSettled = input.controllerWitness.decision === 'allow_with_split'
  return {
    surface: 'agentrun_ingestion',
    authority: splitSettled ? 'controller_heartbeat' : 'none',
    status: input.agentRunIngestion.status === 'unknown' ? 'missing' : 'degraded',
    settlementState: splitSettled ? 'settled_with_split' : 'hold',
    evidenceRefs: [
      input.controllerWitness.quorum_id,
      `agentrun-ingestion:${input.agentRunIngestion.namespace}:${input.agentRunIngestion.status}`,
    ],
    reasonCodes: [`agentrun_ingestion_${input.agentRunIngestion.status}`],
    message: input.agentRunIngestion.message || 'AgentRun ingestion is not locally current',
  }
}

const watchSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => ({
  surface: 'watch_epoch',
  authority: 'kubernetes_rollout',
  status:
    input.watchReliability.status === 'healthy'
      ? 'current'
      : input.watchReliability.status === 'unknown'
        ? 'unknown'
        : 'degraded',
  settlementState: input.watchReliability.status === 'healthy' ? 'settled' : 'hold',
  evidenceRefs: [
    `watch:${input.watchReliability.status}:${input.watchReliability.total_events}:${input.watchReliability.total_errors}:${input.watchReliability.total_restarts}`,
  ],
  reasonCodes: input.watchReliability.status === 'healthy' ? [] : [`watch_epoch_${input.watchReliability.status}`],
  message:
    input.watchReliability.status === 'healthy'
      ? 'Kubernetes watch epoch is current'
      : 'Kubernetes watch epoch is not current enough for material authority',
})

const workflowSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const runtimeReasons = input.runtimeAdapters
    .filter((adapter) => adapter.name === 'workflow' || adapter.name === 'job')
    .flatMap((adapter) => {
      if (adapter.available && (adapter.status === 'healthy' || adapter.status === 'configured')) return []
      return [`runtime_adapter_${normalizeReason(adapter.name)}_${adapter.status}`]
    })
  const reasons = uniqueStrings([
    input.workflows.data_confidence === 'high' ? null : `workflow_data_${input.workflows.data_confidence}`,
    input.workflows.collection_errors > 0 ? 'workflow_collection_errors' : null,
    input.workflows.backoff_limit_exceeded_jobs > 0 ? 'workflow_backoff_limit_exceeded' : null,
    ...runtimeReasons,
  ])

  return {
    surface: 'workflow_runtime',
    authority: 'kubernetes_rollout',
    status: reasons.length === 0 ? 'current' : 'degraded',
    settlementState: reasons.length === 0 ? 'settled' : 'hold',
    evidenceRefs: [
      `workflows:${input.workflows.data_confidence}:active=${input.workflows.active_job_runs}:failed=${input.workflows.recent_failed_jobs}:backoff=${input.workflows.backoff_limit_exceeded_jobs}`,
      ...input.runtimeAdapters
        .filter((adapter) => adapter.name === 'workflow' || adapter.name === 'job')
        .map((adapter) => `runtime-adapter:${adapter.name}:${adapter.status}`),
    ],
    reasonCodes: reasons,
    message: reasons.length === 0 ? 'workflow runtime authority is current' : 'workflow runtime authority is degraded',
  }
}

const sourceSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const deployReceipt = sourceReceiptFor(input.sourceRolloutTruthExchange, 'deploy_widen')
  const mergeReceipt = sourceReceiptFor(input.sourceRolloutTruthExchange, 'merge_ready')
  const receiptsConverged = sourceReceiptAllows(deployReceipt) && sourceReceiptAllows(mergeReceipt)
  const reasons = uniqueStrings([
    input.sourceRolloutTruthExchange.source_head_sha ? null : 'source_head_sha_missing',
    input.sourceRolloutTruthExchange.gitops_revision ? null : 'gitops_revision_missing',
    ...(deployReceipt?.blocking_reasons ?? ['deploy_widen_source_receipt_missing']),
    ...(mergeReceipt?.blocking_reasons ?? ['merge_ready_source_receipt_missing']),
    ...input.sourceRolloutTruthExchange.deployer_summary.held_action_classes.map(
      (actionClass) => `source_rollout_holds_${actionClass}`,
    ),
  ])

  return {
    surface: 'source_gitops',
    authority: receiptsConverged ? 'gitops_revision' : 'none',
    status: receiptsConverged ? 'current' : 'split',
    settlementState: receiptsConverged ? 'settled' : 'repairable_split',
    evidenceRefs: uniqueStrings([
      input.sourceRolloutTruthExchange.exchange_id,
      deployReceipt?.receipt_id,
      mergeReceipt?.receipt_id,
    ]),
    reasonCodes: receiptsConverged ? [] : reasons,
    message: receiptsConverged
      ? 'source, GitOps, and rollout evidence converge'
      : 'source, GitOps, or rollout image evidence is split',
  }
}

const servingImageSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const deployReceipt = sourceReceiptFor(input.sourceRolloutTruthExchange, 'deploy_widen')
  const converged = sourceReceiptAllows(deployReceipt)
  const sourceServingReasons = input.sourceServingContractVerdictExchange.reason_codes.map(
    (reason) => `source_serving:${reason}`,
  )

  return {
    surface: 'serving_image',
    authority: converged ? 'kubernetes_rollout' : 'none',
    status: converged ? 'current' : 'split',
    settlementState: converged ? 'settled' : 'repairable_split',
    evidenceRefs: uniqueStrings([
      input.sourceRolloutTruthExchange.exchange_id,
      input.sourceServingContractVerdictExchange.exchange_id,
      deployReceipt?.receipt_id,
    ]),
    reasonCodes: converged ? [] : uniqueStrings([...(deployReceipt?.blocking_reasons ?? []), ...sourceServingReasons]),
    message: converged ? 'serving image evidence matches desired rollout' : 'serving image evidence is not converged',
  }
}

const stageClearanceSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const dispatchPackets = input.stageClearancePackets.filter((packet) => packet.action_class === 'dispatch_normal')
  const heldPackets = dispatchPackets.filter((packet) => packet.decision !== 'allow')
  const stageCreditHeld = input.stageCreditLedger?.stage_accounts.some(
    (account) => account.action_class === 'dispatch_normal' && account.decision !== 'allow',
  )
  const reasons = uniqueStrings([
    ...heldPackets.flatMap((packet) => packet.reason_codes),
    ...(stageCreditHeld ? ['stage_credit_dispatch_normal_not_allow'] : []),
    ...(input.stageCreditLedger ? [] : ['stage_credit_ledger_missing']),
  ])

  return {
    surface: 'stage_clearance',
    authority: 'database_projection',
    status: reasons.length === 0 ? 'current' : 'held',
    settlementState: reasons.length === 0 ? 'settled' : 'hold',
    evidenceRefs: uniqueStrings([
      input.stageCreditLedger?.ledger_id,
      ...dispatchPackets.map((packet) => packet.packet_id),
      ...input.projectionWatermarks.map((watermark) => watermark.projection_watermark_id),
    ]),
    reasonCodes: reasons,
    message: reasons.length === 0 ? 'stage clearance is current' : 'stage clearance is holding normal dispatch',
  }
}

const torghutSurface = (input: AuthorityProvenanceSettlementInput): SurfaceDraft => {
  const notional = parseNotional(input.torghutConsumerEvidence.max_notional)
  const evidenceCurrent = input.torghutConsumerEvidence.status === 'current'
  if (evidenceCurrent && notional > 0) {
    return {
      surface: 'torghut_capital',
      authority: 'torghut_receipt',
      status: 'current',
      settlementState: 'settled',
      evidenceRefs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
      reasonCodes: input.torghutConsumerEvidence.reason_codes,
      message: 'Torghut capital receipt is current',
    }
  }
  if (evidenceCurrent && notional === 0) {
    return {
      surface: 'torghut_capital',
      authority: 'torghut_receipt',
      status: 'split',
      settlementState: 'repairable_split',
      evidenceRefs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
      reasonCodes: uniqueStrings(['torghut_zero_notional_repair_only', ...input.torghutConsumerEvidence.reason_codes]),
      message: 'Torghut evidence is current for zero-notional repair but not paper or live capital',
    }
  }

  const missing =
    input.torghutConsumerEvidence.status === 'missing' || input.torghutConsumerEvidence.status === 'disabled'
  return {
    surface: 'torghut_capital',
    authority: 'none',
    status: missing ? 'missing' : 'degraded',
    settlementState: 'hold',
    evidenceRefs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
    reasonCodes: uniqueStrings([
      `torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`,
      ...input.torghutConsumerEvidence.reason_codes,
    ]),
    message: input.torghutConsumerEvidence.message || 'Torghut capital evidence is not current',
  }
}

const buildSurfaces = (input: AuthorityProvenanceSettlementInput, freshUntil: string) =>
  [
    controllerSurface(input),
    agentRunIngestionSurface(input),
    watchSurface(input),
    sourceSurface(input),
    servingImageSurface(input),
    databaseSurface(input),
    workflowSurface(input),
    stageClearanceSurface(input),
    torghutSurface(input),
  ].map((draft) => surfaceFromDraft({ draft, now: input.now, freshUntil }))

const surfaceByName = (surfaces: AuthorityProvenanceSurface[]) =>
  new Map(surfaces.map((surface) => [surface.surface, surface]))

const controllerIsAuthoritative = (input: AuthorityProvenanceSettlementInput) =>
  input.controllerWitness.decision === 'allow' || input.controllerWitness.decision === 'allow_with_split'

const sourceConverged = (input: AuthorityProvenanceSettlementInput) =>
  sourceReceiptAllows(sourceReceiptFor(input.sourceRolloutTruthExchange, 'deploy_widen')) &&
  sourceReceiptAllows(sourceReceiptFor(input.sourceRolloutTruthExchange, 'merge_ready'))

const torghutObserveAllowed = (input: AuthorityProvenanceSettlementInput) =>
  input.torghutConsumerEvidence.status !== 'unavailable' &&
  input.torghutConsumerEvidence.status !== 'route_missing' &&
  input.torghutConsumerEvidence.status !== 'schema_mismatch'

const torghutZeroNotionalRepairAvailable = (input: AuthorityProvenanceSettlementInput) =>
  input.torghutConsumerEvidence.status === 'current' &&
  Boolean(input.torghutConsumerEvidence.receipt_id) &&
  parseNotional(input.torghutConsumerEvidence.max_notional) === 0

const torghutCapitalOpen = (input: AuthorityProvenanceSettlementInput) =>
  input.torghutConsumerEvidence.status === 'current' && parseNotional(input.torghutConsumerEvidence.max_notional) > 0

const resolveSettlementState = (
  input: AuthorityProvenanceSettlementInput,
  surfaces: AuthorityProvenanceSurface[],
): AuthorityProvenanceSettlementState => {
  if (surfaces.some((surface) => surface.settlement_state === 'block')) return 'block'

  const controllerSurfaceState = surfaceByName(surfaces).get('controller_process')?.settlement_state ?? 'hold'
  if (controllerSurfaceState === 'hold' || controllerSurfaceState === 'block') return controllerSurfaceState

  const splitTopology =
    input.controllerWitness.decision === 'allow_with_split' || input.agentRunIngestion.status !== 'healthy'
  if (splitTopology && controllerIsAuthoritative(input)) return 'settled_with_split'

  if (!sourceConverged(input)) {
    if (controllerIsAuthoritative(input) && torghutObserveAllowed(input)) return 'repairable_split'
    return 'hold'
  }

  const strictest = strictestSettlement(
    surfaces.filter((surface) => surface.surface !== 'torghut_capital').map((surface) => surface.settlement_state),
  )
  if (strictest === 'repairable_split') return 'repairable_split'
  if (strictest === 'settled_with_split') return 'settled_with_split'
  if (strictest === 'hold' || strictest === 'block') return strictest
  return 'settled'
}

const resolveWinningAuthority = (
  input: AuthorityProvenanceSettlementInput,
  settlementState: AuthorityProvenanceSettlementState,
): AuthorityProvenanceWinningAuthority => {
  if (settlementState === 'block' || settlementState === 'hold') return 'none'
  if (settlementState === 'settled' && sourceConverged(input)) return 'gitops_revision'
  if (controllerIsAuthoritative(input)) return 'controller_heartbeat'
  if (input.rolloutHealth.status === 'healthy') return 'kubernetes_rollout'
  if (input.database.status === 'healthy') return 'database_projection'
  return 'none'
}

const actionReasons = (values: Array<string | null | undefined>) => uniqueStrings(values).map(normalizeReason)

const budgetFor = (input: AuthorityProvenanceSettlementInput, actionClass: ActionSloBudgetActionClass) =>
  input.actionSloBudgets.find((budget) => budget.action_class === actionClass) ?? null

const buildActionDecision = (input: {
  statusInput: AuthorityProvenanceSettlementInput
  settlementState: AuthorityProvenanceSettlementState
  actionClass: ActionSloBudgetActionClass
}): AuthorityProvenanceActionDecision => {
  const { statusInput, settlementState, actionClass } = input
  const sourceReceipt = sourceReceiptFor(statusInput.sourceRolloutTruthExchange, actionClass)
  const budget = budgetFor(statusInput, actionClass)
  const readyDecision = decisionForReadyTruth(statusInput.readyTruthArbiter, actionClass)
  const baseEvidenceRefs = uniqueStrings([
    statusInput.controllerWitness.quorum_id,
    statusInput.sourceRolloutTruthExchange.exchange_id,
    statusInput.stageCreditLedger?.ledger_id,
    sourceReceipt?.receipt_id,
    budget?.budget_id,
    statusInput.torghutConsumerEvidence.receipt_id,
  ])
  let decision: AuthorityProvenanceActionDecisionValue = 'hold'
  let reasonCodes: string[] = []
  let maxDispatches: number | null = budget?.max_dispatches ?? null
  let maxRuntimeSeconds: number | null = budget?.max_runtime_seconds ?? null
  let maxNotional = budget?.max_notional ?? 0

  if (actionClass === 'serve_readonly') {
    decision = statusInput.readyTruthArbiter.serving_readiness === 'down' ? 'block' : 'allow'
    reasonCodes = decision === 'allow' ? [] : ['serving_readiness_down']
    maxDispatches = null
    maxRuntimeSeconds = null
  } else if (actionClass === 'torghut_observe') {
    decision = torghutObserveAllowed(statusInput) ? 'allow' : 'hold'
    reasonCodes =
      decision === 'allow' ? [] : [`torghut_consumer_evidence_${statusInput.torghutConsumerEvidence.status}`]
  } else if (actionClass === 'dispatch_repair') {
    const coreCurrent =
      controllerIsAuthoritative(statusInput) &&
      statusInput.database.status === 'healthy' &&
      statusInput.watchReliability.status === 'healthy' &&
      statusInput.workflows.data_confidence === 'high'
    if (coreCurrent && torghutZeroNotionalRepairAvailable(statusInput)) {
      decision = 'allow'
      reasonCodes = ['torghut_zero_notional_repair_receipt_current']
      maxDispatches = Math.max(1, budget?.max_dispatches ?? 1)
      maxRuntimeSeconds = budget?.max_runtime_seconds ?? DEFAULT_REENTRY_WINDOW_SECONDS
      maxNotional = 0
    } else {
      decision = 'hold'
      reasonCodes = actionReasons([
        coreCurrent ? null : 'core_authority_not_current',
        torghutZeroNotionalRepairAvailable(statusInput) ? null : 'torghut_zero_notional_repair_receipt_missing',
      ])
    }
  } else if (actionClass === 'dispatch_normal') {
    if (
      settlementState === 'settled' &&
      sourceConverged(statusInput) &&
      statusInput.agentRunIngestion.status === 'healthy'
    ) {
      decision = 'allow'
      reasonCodes = []
      maxDispatches = Math.max(1, budget?.max_dispatches ?? 1)
      maxRuntimeSeconds = budget?.max_runtime_seconds ?? DEFAULT_REENTRY_WINDOW_SECONDS
    } else if (
      controllerIsAuthoritative(statusInput) &&
      (settlementState === 'settled_with_split' || settlementState === 'repairable_split')
    ) {
      decision = 'repair_only'
      reasonCodes = actionReasons([
        settlementState,
        statusInput.agentRunIngestion.status === 'healthy'
          ? null
          : `agentrun_ingestion_${statusInput.agentRunIngestion.status}`,
        sourceConverged(statusInput) ? null : 'source_rollout_truth_not_converged',
      ])
      maxDispatches = 1
      maxRuntimeSeconds = budget?.max_runtime_seconds ?? DEFAULT_REENTRY_WINDOW_SECONDS
    } else {
      decision = 'hold'
      reasonCodes = actionReasons([settlementState, ...statusInput.controllerWitness.reason_codes])
      maxDispatches = 0
      maxRuntimeSeconds = 0
    }
  } else if (actionClass === 'deploy_widen' || actionClass === 'merge_ready') {
    if (settlementState === 'settled' && sourceReceiptAllows(sourceReceipt)) {
      decision = 'allow'
      reasonCodes = []
    } else {
      decision = 'hold'
      reasonCodes = actionReasons([
        sourceReceipt ? null : `${actionClass}_source_receipt_missing`,
        ...(sourceReceipt?.blocking_reasons ?? []),
        sourceConverged(statusInput) ? null : 'source_rollout_truth_not_converged',
        settlementState === 'settled' ? null : `authority_${settlementState}`,
      ])
      maxDispatches = 0
      maxRuntimeSeconds = 0
    }
  } else if (CAPITAL_ACTION_CLASSES.includes(actionClass)) {
    if (torghutCapitalOpen(statusInput)) {
      decision = sourceReceiptAllows(sourceReceipt) ? 'allow' : 'hold'
      reasonCodes = decision === 'allow' ? [] : ['source_rollout_truth_not_converged']
      maxNotional = parseNotional(statusInput.torghutConsumerEvidence.max_notional)
    } else {
      decision = actionClass === 'paper_canary' ? 'hold' : 'block'
      reasonCodes = actionReasons([
        'torghut_capital_receipt_not_open',
        statusInput.torghutConsumerEvidence.max_notional === '0' ? 'torghut_zero_notional_repair_only' : null,
        ...statusInput.torghutConsumerEvidence.reason_codes,
      ])
      maxNotional = 0
    }
  }

  if (readyDecision === 'block') {
    decision = 'block'
    reasonCodes = uniqueStrings([...reasonCodes, `ready_truth_${readyDecision}`])
  } else if (
    readyDecision === 'hold' &&
    decision === 'allow' &&
    actionClass !== 'serve_readonly' &&
    actionClass !== 'dispatch_repair' &&
    actionClass !== 'torghut_observe'
  ) {
    decision = 'hold'
    reasonCodes = uniqueStrings([...reasonCodes, 'ready_truth_hold'])
  } else if (readyDecision === 'repair_only' && decision === 'allow' && actionClass === 'dispatch_normal') {
    decision = 'repair_only'
    reasonCodes = uniqueStrings([...reasonCodes, 'ready_truth_repair_only'])
  }

  return {
    action_class: actionClass,
    decision,
    reason_codes: uniqueStrings(reasonCodes).map(normalizeReason),
    evidence_refs: baseEvidenceRefs,
    max_dispatches: maxDispatches,
    max_runtime_seconds: maxRuntimeSeconds,
    max_notional: Math.max(0, maxNotional),
    rollback_target:
      decision === 'allow'
        ? ROLLBACK_TARGET
        : (budget?.rollback_target ?? 'hold material action until authority provenance settlement converges'),
  }
}

const buildActionDecisions = (
  input: AuthorityProvenanceSettlementInput,
  settlementState: AuthorityProvenanceSettlementState,
) =>
  ACTION_CLASSES.map((actionClass) =>
    buildActionDecision({
      statusInput: input,
      settlementState,
      actionClass,
    }),
  )

const buildReentryWindows = (input: {
  statusInput: AuthorityProvenanceSettlementInput
  actionDecisions: AuthorityProvenanceActionDecision[]
  freshUntil: string
}): AuthorityProvenanceReentryWindow[] => {
  const normalDecision = input.actionDecisions.find((decision) => decision.action_class === 'dispatch_normal')
  if (!normalDecision || normalDecision.decision !== 'allow') return []

  const futures = input.statusInput.stageCreditLedger?.runner_slot_futures.filter(
    (future) => future.action_class === 'dispatch_normal' && future.settlement_state === 'open',
  )
  if (futures && futures.length > 0) {
    return futures.map((future) => ({
      window_id: `authority-reentry-window:${hashJson([future.future_id, input.freshUntil])}`,
      stage: future.stage,
      action_class: 'dispatch_normal',
      max_dispatches: Math.max(1, future.max_dispatches),
      max_runtime_seconds: future.max_runtime_seconds,
      max_notional: Math.max(0, future.max_notional),
      required_receipts: uniqueStrings([
        input.statusInput.controllerWitness.quorum_id,
        input.statusInput.sourceRolloutTruthExchange.exchange_id,
        input.statusInput.stageCreditLedger?.ledger_id,
        future.future_id,
        ...future.required_receipts,
      ]),
      expires_at: future.expires_at,
    }))
  }

  const stage =
    input.statusInput.stageClearancePackets.find(
      (packet) => packet.action_class === 'dispatch_normal' && packet.decision === 'allow',
    )?.stage ?? ('implement' as StageClearanceStage)

  return [
    {
      window_id: `authority-reentry-window:${hashJson([
        input.statusInput.namespace,
        stage,
        normalDecision.evidence_refs,
        input.freshUntil,
      ])}`,
      stage,
      action_class: 'dispatch_normal',
      max_dispatches: Math.max(1, normalDecision.max_dispatches ?? 1),
      max_runtime_seconds: normalDecision.max_runtime_seconds ?? DEFAULT_REENTRY_WINDOW_SECONDS,
      max_notional: normalDecision.max_notional,
      required_receipts: normalDecision.evidence_refs,
      expires_at: input.freshUntil,
    },
  ]
}

export const buildAuthorityProvenanceSettlement = (
  input: AuthorityProvenanceSettlementInput,
  mode = resolveAuthorityProvenanceSettlementMode(),
): AuthorityProvenanceSettlement => {
  const freshUntil = addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
  const surfaces = buildSurfaces(input, freshUntil)
  const settlementState = resolveSettlementState(input, surfaces)
  const winningAuthority = resolveWinningAuthority(input, settlementState)
  const actionClassDecisions = buildActionDecisions(input, settlementState)
  const reentryWindows = buildReentryWindows({
    statusInput: input,
    actionDecisions: actionClassDecisions,
    freshUntil,
  })
  const decisionFor = (actionClass: ActionSloBudgetActionClass) =>
    actionClassDecisions.find((decision) => decision.action_class === actionClass)?.decision ?? 'hold'
  const settlementId = `authority-provenance-settlement:${input.namespace}:${hashJson({
    state: settlementState,
    winning_authority: winningAuthority,
    surfaces: surfaces.map((surface) => [surface.surface, surface.status, surface.reason_codes]),
    actions: actionClassDecisions.map((decision) => [decision.action_class, decision.decision]),
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    settlement_id: settlementId,
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    evidence_mode: mode,
    surfaces,
    winning_authority: winningAuthority,
    settlement_state: settlementState,
    action_class_decisions: actionClassDecisions,
    reentry_windows: reentryWindows,
    rollback_target: ROLLBACK_TARGET,
    handoff_summary: `authority ${settlementState}; winner=${winningAuthority}; dispatch_normal=${decisionFor(
      'dispatch_normal',
    )}; deploy_widen=${decisionFor('deploy_widen')}; merge_ready=${decisionFor('merge_ready')}`,
  }
}
