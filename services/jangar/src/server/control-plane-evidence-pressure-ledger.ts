import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  EvidencePressureActionBudget,
  EvidencePressureDecision,
  EvidencePressureLedger,
  EvidencePressureLedgerMode,
  EvidencePressureSeverity,
  EvidencePressureSource,
  EvidencePressureSourceClass,
  EvidencePressureWatchBackoffState,
  TorghutConsumerEvidenceStatus,
} from '~/data/agents-control-plane'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT =
  'docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.evidence-pressure-ledger.v1' as const
const DEFAULT_TTL_SECONDS = 60
const ROLLBACK_TARGET = 'JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE=observe'

const GOVERNING_DESIGN_REFS = [
  EVIDENCE_PRESSURE_LEDGER_DESIGN_ARTIFACT,
  'docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md',
  'docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md',
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

const NORMAL_DISPATCH_ACTIONS: ActionSloBudgetActionClass[] = ['dispatch_normal', 'deploy_widen', 'merge_ready']

const CAPITAL_ACTIONS: ActionSloBudgetActionClass[] = ['paper_canary', 'live_micro_canary', 'live_scale']

const SEVERITY_RANK: Record<EvidencePressureSeverity, number> = {
  info: 0,
  warning: 1,
  hold: 2,
  block: 3,
}

const SEVERITY_TAX: Record<EvidencePressureSeverity, number> = {
  info: 0,
  warning: 25,
  hold: 75,
  block: 100,
}

export type EvidencePressureMetricsSinkStatus = {
  status: 'disabled' | 'healthy' | 'degraded' | 'unknown'
  endpoint: string | null
  message: string
  reason_codes: string[]
}

export type EvidencePressureGithubIngestStatus = {
  status: 'healthy' | 'degraded' | 'unknown'
  active_missing_ref_suppressions: number
  reason_codes: string[]
  message: string
  evidence_refs: string[]
}

export type EvidencePressureControllerReadiness = {
  name: string
  enabled: boolean
  started: boolean
  crdsReady: boolean | null
  message: string
}

export type EvidencePressureLedgerInput = {
  now: Date
  namespace: string
  sourceHeadSha?: string | null
  gitopsRevision?: string | null
  watchReliability: ControlPlaneWatchReliability
  controllerWitness?: ControlPlaneControllerWitnessQuorum | null
  controllerReadiness?: EvidencePressureControllerReadiness[]
  rolloutHealth?: ControlPlaneRolloutHealth | null
  database?: DatabaseStatus | null
  metricsSink?: EvidencePressureMetricsSinkStatus | null
  githubIngest?: EvidencePressureGithubIngestStatus | null
  torghutConsumerEvidence?: TorghutConsumerEvidenceStatus | null
}

type SourceDraft = {
  sourceClass: EvidencePressureSourceClass
  severity: EvidencePressureSeverity
  evidenceRef: string
  message: string
  retryable: boolean
  terminal: boolean
  suggestedBackoffSeconds: number
  valueGates: string[]
  reasonCodes: string[]
}

export const resolveEvidencePressureLedgerMode = (env: NodeJS.ProcessEnv = process.env): EvidencePressureLedgerMode => {
  const normalized = env.JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE?.trim().toLowerCase()
  if (normalized === 'observe' || normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') {
    return normalized
  }
  return 'observe'
}

export const isEvidencePressureLedgerEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.JANGAR_EVIDENCE_PRESSURE_LEDGER_ENABLED?.trim().toLowerCase() !== 'false'

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

const sourceFromDraft = (input: { now: Date; expiresAt: string; draft: SourceDraft }): EvidencePressureSource => {
  const reasonCodes = uniqueStrings(input.draft.reasonCodes.map(normalizeReason))
  const sourceId = `evidence-pressure-source:${input.draft.sourceClass}:${hashJson({
    severity: input.draft.severity,
    evidence_ref: input.draft.evidenceRef,
    reason_codes: reasonCodes,
  })}`

  return {
    source_id: sourceId,
    source_class: input.draft.sourceClass,
    severity: input.draft.severity,
    observed_at: input.now.toISOString(),
    expires_at: input.expiresAt,
    evidence_ref: input.draft.evidenceRef,
    message: input.draft.message,
    retryable: input.draft.retryable,
    terminal: input.draft.terminal,
    suggested_backoff_seconds: input.draft.suggestedBackoffSeconds,
    value_gates: uniqueStrings(input.draft.valueGates),
    reason_codes: reasonCodes,
  }
}

const reasonKeys = (reasons: Record<string, number> | undefined) =>
  Object.entries(reasons ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason]) => normalizeReason(reason))

const watchPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const watch = input.watchReliability
  if (watch.status === 'healthy') return null

  if (watch.status === 'unknown') {
    return {
      sourceClass: 'kubernetes_watch',
      severity: 'info',
      evidenceRef: 'watch:unknown',
      message: 'Kubernetes watch evidence has not observed a fresh stream in the current window',
      retryable: true,
      terminal: false,
      suggestedBackoffSeconds: 30,
      valueGates: ['ready_status_truth', 'handoff_evidence_quality'],
      reasonCodes: ['kubernetes_watch_unknown'],
    }
  }

  const errorReasons = uniqueStrings(watch.streams.flatMap((stream) => reasonKeys(stream.error_reasons)))
  const restartReasons = uniqueStrings(watch.streams.flatMap((stream) => reasonKeys(stream.restart_reasons)))
  const rateLimited = [...errorReasons, ...restartReasons].some((reason) => reason.includes('rate_limited'))
  const reasonCodes = uniqueStrings([
    rateLimited ? 'kubernetes_watch_rate_limited' : 'kubernetes_watch_degraded',
    ...errorReasons.map((reason) => `watch_error:${reason}`),
    ...restartReasons.map((reason) => `watch_restart:${reason}`),
  ])

  return {
    sourceClass: 'kubernetes_watch',
    severity: rateLimited ? 'hold' : 'warning',
    evidenceRef: `watch:${watch.status}:errors=${watch.total_errors}:restarts=${watch.total_restarts}`,
    message: rateLimited
      ? 'Kubernetes watch pressure includes API-server rate limiting; normal dispatch should back off'
      : 'Kubernetes watch errors or restarts are active in the pressure window',
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: rateLimited ? 300 : 60,
    valueGates: ['failed_agentrun_rate', 'ready_status_truth', 'handoff_evidence_quality'],
    reasonCodes,
  }
}

const controllerWitnessPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const witness = input.controllerWitness
  if (!witness || witness.decision === 'allow') return null

  const severity: EvidencePressureSeverity =
    witness.decision === 'block'
      ? 'block'
      : witness.decision === 'hold_material' || witness.decision === 'repair_only'
        ? 'hold'
        : 'warning'

  return {
    sourceClass: 'controller_replica',
    severity,
    evidenceRef: witness.quorum_id,
    message: witness.message || `controller witness decision is ${witness.decision}`,
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: severity === 'hold' ? 120 : 60,
    valueGates: ['failed_agentrun_rate', 'ready_status_truth'],
    reasonCodes: [`controller_witness_${witness.decision}`, ...witness.reason_codes],
  }
}

const controllerReadinessPressureSources = (input: EvidencePressureLedgerInput): SourceDraft[] => {
  if (input.controllerWitness) return []

  return (input.controllerReadiness ?? [])
    .filter((controller) => controller.enabled && (!controller.started || controller.crdsReady === false))
    .map((controller): SourceDraft => {
      const reasonCodes = [
        controller.started ? null : `${controller.name}_not_started`,
        controller.crdsReady === false ? `${controller.name}_crds_not_ready` : null,
      ]
      return {
        sourceClass: 'controller_replica',
        severity: 'hold',
        evidenceRef: `ready-controller:${controller.name}`,
        message: controller.message || `${controller.name} is not ready for material dispatch`,
        retryable: true,
        terminal: false,
        suggestedBackoffSeconds: 120,
        valueGates: ['failed_agentrun_rate', 'ready_status_truth'],
        reasonCodes: uniqueStrings(reasonCodes),
      }
    })
}

const rolloutPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const rollout = input.rolloutHealth
  if (!rollout || rollout.status === 'healthy') return null

  return {
    sourceClass: 'controller_replica',
    severity: rollout.status === 'degraded' ? 'hold' : 'warning',
    evidenceRef: `rollout:${rollout.status}:${rollout.observed_deployments}:${rollout.degraded_deployments}`,
    message: rollout.message || `rollout health is ${rollout.status}`,
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: 120,
    valueGates: ['pr_to_rollout_latency', 'ready_status_truth'],
    reasonCodes: [`rollout_health_${rollout.status}`],
  }
}

const metricsSinkPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const metricsSink = input.metricsSink
  if (!metricsSink || metricsSink.status === 'healthy' || metricsSink.status === 'disabled') return null

  return {
    sourceClass: 'metrics_sink',
    severity: metricsSink.status === 'degraded' ? 'hold' : 'warning',
    evidenceRef: `metrics-sink:${metricsSink.endpoint ?? 'unconfigured'}`,
    message: metricsSink.message,
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: 120,
    valueGates: ['pr_to_rollout_latency', 'handoff_evidence_quality'],
    reasonCodes: uniqueStrings([`metrics_sink_${metricsSink.status}`, ...metricsSink.reason_codes]),
  }
}

const githubIngestPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const githubIngest = input.githubIngest
  if (!githubIngest || githubIngest.status === 'healthy') return null

  const missingRefSuppressed = githubIngest.active_missing_ref_suppressions > 0
  return {
    sourceClass: 'github_ingest',
    severity: missingRefSuppressed ? 'info' : 'warning',
    evidenceRef: githubIngest.evidence_refs[0] ?? 'github-review-ingest:unknown',
    message: githubIngest.message,
    retryable: !missingRefSuppressed,
    terminal: missingRefSuppressed,
    suggestedBackoffSeconds: missingRefSuppressed ? 0 : 60,
    valueGates: ['manual_intervention_count', 'handoff_evidence_quality'],
    reasonCodes: uniqueStrings([
      githubIngest.status === 'unknown' ? 'github_ingest_unknown' : 'github_ingest_degraded',
      ...githubIngest.reason_codes,
    ]),
  }
}

const databasePressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const database = input.database
  if (!database || database.status === 'healthy') return null
  if (database.status === 'disabled') {
    return {
      sourceClass: 'db_access',
      severity: 'info',
      evidenceRef: 'database:disabled',
      message: database.message || 'database proof surface disabled',
      retryable: false,
      terminal: true,
      suggestedBackoffSeconds: 0,
      valueGates: ['handoff_evidence_quality'],
      reasonCodes: ['database_disabled'],
    }
  }

  return {
    sourceClass: 'db_access',
    severity: database.connected ? 'hold' : 'block',
    evidenceRef: `database:${database.status}:migrations=${database.migration_consistency.status}`,
    message: database.message || `database status is ${database.status}`,
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: 120,
    valueGates: ['ready_status_truth', 'handoff_evidence_quality'],
    reasonCodes: uniqueStrings([
      `database_${database.status}`,
      `database_migrations_${database.migration_consistency.status}`,
    ]),
  }
}

const torghutPressureSource = (input: EvidencePressureLedgerInput): SourceDraft | null => {
  const torghut = input.torghutConsumerEvidence
  if (!torghut || torghut.status === 'current' || torghut.status === 'disabled') return null

  const severity: EvidencePressureSeverity = torghut.status === 'stale' ? 'warning' : 'hold'
  return {
    sourceClass: 'torghut_freshness',
    severity,
    evidenceRef: torghut.receipt_id ?? `torghut-consumer-evidence:${torghut.status}`,
    message: torghut.message || `Torghut consumer evidence is ${torghut.status}`,
    retryable: true,
    terminal: false,
    suggestedBackoffSeconds: severity === 'hold' ? 120 : 60,
    valueGates: ['failed_agentrun_rate', 'ready_status_truth', 'handoff_evidence_quality'],
    reasonCodes: uniqueStrings([`torghut_consumer_evidence_${torghut.status}`, ...torghut.reason_codes]),
  }
}

const buildPressureSources = (input: EvidencePressureLedgerInput, expiresAt: string) =>
  uniqueSources(
    [
      watchPressureSource(input),
      controllerWitnessPressureSource(input),
      ...controllerReadinessPressureSources(input),
      rolloutPressureSource(input),
      metricsSinkPressureSource(input),
      githubIngestPressureSource(input),
      databasePressureSource(input),
      torghutPressureSource(input),
    ]
      .filter((draft): draft is SourceDraft => draft !== null)
      .map((draft) => sourceFromDraft({ now: input.now, expiresAt, draft })),
  )

const uniqueSources = (sources: EvidencePressureSource[]) => {
  const byId = new Map<string, EvidencePressureSource>()
  for (const source of sources) {
    byId.set(source.source_id, source)
  }
  return [...byId.values()].sort((left, right) => {
    const severityDelta = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    if (severityDelta !== 0) return severityDelta
    return left.source_class.localeCompare(right.source_class)
  })
}

const activePressureSources = (sources: EvidencePressureSource[]) =>
  sources.filter((source) => !(source.terminal && source.severity === 'info'))

const strictestSeverity = (sources: EvidencePressureSource[]): EvidencePressureSeverity => {
  let strictest: EvidencePressureSeverity = 'info'
  for (const source of sources) {
    if (SEVERITY_RANK[source.severity] > SEVERITY_RANK[strictest]) strictest = source.severity
  }
  return strictest
}

const stateForSources = (sources: EvidencePressureSource[]): EvidencePressureWatchBackoffState => {
  const strictest = strictestSeverity(activePressureSources(sources))
  if (strictest === 'block') return 'blind'
  if (strictest === 'hold') return 'brownout'
  if (strictest === 'warning') return 'pressured'
  return 'calm'
}

const maxBackoff = (sources: EvidencePressureSource[], fallback: number) =>
  Math.max(fallback, ...sources.map((source) => source.suggested_backoff_seconds))

const buildWatchBackoffPolicy = (sources: EvidencePressureSource[]) => {
  const state = stateForSources(sources)
  const activeSources = activePressureSources(sources)
  const stopRetryReasonCodes = uniqueStrings(
    sources.filter((source) => source.terminal).flatMap((source) => source.reason_codes),
  )
  const openRepairReasonCodes = uniqueStrings(
    activeSources.filter((source) => source.severity !== 'block').flatMap((source) => source.reason_codes),
  )

  if (state === 'blind') {
    return {
      state,
      max_new_list_requests_per_minute: 0,
      max_new_agent_runs_per_stage: 0,
      jitter_seconds: 30,
      retry_after_seconds: maxBackoff(activeSources, 300),
      stop_retry_reason_codes: stopRetryReasonCodes,
      open_repair_reason_codes: [],
    }
  }

  if (state === 'brownout') {
    return {
      state,
      max_new_list_requests_per_minute: 5,
      max_new_agent_runs_per_stage: 0,
      jitter_seconds: 20,
      retry_after_seconds: maxBackoff(activeSources, 120),
      stop_retry_reason_codes: stopRetryReasonCodes,
      open_repair_reason_codes: openRepairReasonCodes,
    }
  }

  if (state === 'pressured') {
    return {
      state,
      max_new_list_requests_per_minute: 20,
      max_new_agent_runs_per_stage: 1,
      jitter_seconds: 10,
      retry_after_seconds: maxBackoff(activeSources, 60),
      stop_retry_reason_codes: stopRetryReasonCodes,
      open_repair_reason_codes: openRepairReasonCodes,
    }
  }

  return {
    state,
    max_new_list_requests_per_minute: 60,
    max_new_agent_runs_per_stage: 4,
    jitter_seconds: 5,
    retry_after_seconds: 0,
    stop_retry_reason_codes: stopRetryReasonCodes,
    open_repair_reason_codes: openRepairReasonCodes,
  }
}

const relevantSourcesForAction = (sources: EvidencePressureSource[], actionClass: ActionSloBudgetActionClass) => {
  const activeSources = activePressureSources(sources)
  if (actionClass === 'serve_readonly') {
    return activeSources.filter((source) => source.severity === 'block')
  }
  if (actionClass === 'torghut_observe') {
    return activeSources.filter((source) => source.source_class === 'torghut_freshness')
  }
  if (actionClass === 'dispatch_repair') {
    return activeSources
  }
  if (NORMAL_DISPATCH_ACTIONS.includes(actionClass)) {
    return activeSources
  }
  if (CAPITAL_ACTIONS.includes(actionClass)) {
    return activeSources.filter((source) => source.source_class === 'torghut_freshness' || source.severity === 'block')
  }
  return activeSources
}

const hasZeroNotionalRepairLot = (torghut: TorghutConsumerEvidenceStatus | null | undefined) => {
  if (!torghut) return false
  if (parseNotional(torghut.max_notional) > 0) return false
  if ((torghut.repair_bid_settlement_dispatchable_lot_ids ?? []).length > 0) return true
  if ((torghut.routeable_exchange_zero_notional_repair_lot_ids ?? []).length > 0) return true
  return torghut.decision === 'repair' || torghut.decision === 'repair_only'
}

const repairReceiptRefs = (torghut: TorghutConsumerEvidenceStatus | null | undefined) =>
  uniqueStrings([
    torghut?.repair_bid_settlement_ledger_id,
    torghut?.route_warrant_id,
    ...(torghut?.repair_bid_settlement_dispatchable_lot_ids ?? []),
    ...(torghut?.routeable_exchange_zero_notional_repair_lot_ids ?? []),
  ])

const decisionForAction = (input: {
  actionClass: ActionSloBudgetActionClass
  sources: EvidencePressureSource[]
  torghutConsumerEvidence?: TorghutConsumerEvidenceStatus | null
}): EvidencePressureDecision => {
  const strictest = strictestSeverity(input.sources)
  if (input.actionClass === 'serve_readonly') return strictest === 'block' ? 'block' : 'allow'
  if (input.actionClass === 'torghut_observe') return strictest === 'block' ? 'block' : 'allow'

  if (input.actionClass === 'dispatch_repair') {
    if (strictest === 'block') return 'block'
    if (input.sources.length === 0) return 'allow'
    return hasZeroNotionalRepairLot(input.torghutConsumerEvidence) ? 'repair_only' : 'hold'
  }

  if (strictest === 'block') return 'block'
  if (strictest === 'hold' || strictest === 'warning') return 'hold'
  return 'allow'
}

const buildActionPressureBudget = (input: {
  actionClass: ActionSloBudgetActionClass
  sources: EvidencePressureSource[]
  torghutConsumerEvidence?: TorghutConsumerEvidenceStatus | null
}): EvidencePressureActionBudget => {
  const relevantSources = relevantSourcesForAction(input.sources, input.actionClass)
  const decision = decisionForAction({
    actionClass: input.actionClass,
    sources: relevantSources,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
  })
  const repairOnly = decision === 'repair_only'
  const maxDispatches = repairOnly ? 1 : decision === 'allow' ? null : 0
  const maxRuntimeSeconds = repairOnly ? 1800 : null

  return {
    action_class: input.actionClass,
    decision,
    pressure_tax: Math.min(
      100,
      relevantSources.reduce((total, source) => total + SEVERITY_TAX[source.severity], 0),
    ),
    max_dispatches: maxDispatches,
    max_runtime_seconds: maxRuntimeSeconds,
    max_notional: 0,
    required_repair_receipts: repairOnly ? repairReceiptRefs(input.torghutConsumerEvidence) : [],
    reason_codes: uniqueStrings(relevantSources.flatMap((source) => source.reason_codes)),
    rollback_target: ROLLBACK_TARGET,
  }
}

const strictestDecision = (budgets: EvidencePressureActionBudget[]): EvidencePressureDecision => {
  if (budgets.some((budget) => budget.decision === 'block')) return 'block'
  if (budgets.some((budget) => budget.decision === 'hold')) return 'hold'
  if (budgets.some((budget) => budget.decision === 'repair_only')) return 'repair_only'
  return 'allow'
}

export const buildEvidencePressureLedger = (input: EvidencePressureLedgerInput): EvidencePressureLedger => {
  const generatedAt = input.now.toISOString()
  const freshUntil = addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
  const pressureSources = buildPressureSources(input, freshUntil)
  const watchBackoffPolicy = buildWatchBackoffPolicy(pressureSources)
  const actionPressureBudget = ACTION_CLASSES.map((actionClass) =>
    buildActionPressureBudget({
      actionClass,
      sources: pressureSources,
      torghutConsumerEvidence: input.torghutConsumerEvidence,
    }),
  )
  const ledgerId = `evidence-pressure-ledger:${input.namespace}:${hashJson({
    generated_at: generatedAt,
    sources: pressureSources.map((source) => source.source_id),
    mode: resolveEvidencePressureLedgerMode(),
  })}`
  const heldActionClasses = actionPressureBudget
    .filter((budget) => budget.decision === 'hold' || budget.decision === 'block')
    .map((budget) => budget.action_class)
  const repairActionClasses = actionPressureBudget
    .filter((budget) => budget.decision === 'repair_only')
    .map((budget) => budget.action_class)
  const schedulerBudgets = actionPressureBudget.filter((budget) =>
    ['dispatch_repair', 'dispatch_normal'].includes(budget.action_class),
  )
  const deployerBudgets = actionPressureBudget.filter((budget) =>
    ['deploy_widen', 'merge_ready'].includes(budget.action_class),
  )

  return {
    schema_version: SCHEMA_VERSION,
    ledger_id: ledgerId,
    namespace: input.namespace,
    generated_at: generatedAt,
    fresh_until: freshUntil,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    observed_revision: {
      source_head_sha: input.sourceHeadSha ?? process.env.JANGAR_SOURCE_HEAD_SHA ?? process.env.JANGAR_COMMIT ?? null,
      gitops_revision: input.gitopsRevision ?? process.env.JANGAR_GITOPS_REVISION ?? null,
    },
    evidence_mode: resolveEvidencePressureLedgerMode(),
    pressure_sources: pressureSources,
    watch_backoff_policy: watchBackoffPolicy,
    action_pressure_budget: actionPressureBudget,
    scheduler_handoff: {
      status: strictestDecision(schedulerBudgets),
      ledger_ref: ledgerId,
      held_action_classes: heldActionClasses.filter((actionClass) =>
        ['dispatch_repair', 'dispatch_normal'].includes(actionClass),
      ),
      repair_action_classes: repairActionClasses,
      reason_codes: uniqueStrings(schedulerBudgets.flatMap((budget) => budget.reason_codes)),
    },
    deployer_handoff: {
      status: strictestDecision(deployerBudgets),
      ledger_ref: ledgerId,
      held_action_classes: heldActionClasses.filter((actionClass) =>
        ['deploy_widen', 'merge_ready'].includes(actionClass),
      ),
      reason_codes: uniqueStrings(deployerBudgets.flatMap((budget) => budget.reason_codes)),
    },
    rollback_target: ROLLBACK_TARGET,
  }
}

export const controllerReadinessFromStatus = (controllers: ControllerStatus[]): EvidencePressureControllerReadiness[] =>
  controllers.map((controller) => ({
    name: controller.name,
    enabled: controller.enabled,
    started: controller.started,
    crdsReady: controller.crds_ready,
    message: controller.message,
  }))
