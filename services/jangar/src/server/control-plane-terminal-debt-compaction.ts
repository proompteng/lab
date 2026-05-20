import { createHash } from 'node:crypto'
import process from 'node:process'

import {
  SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS,
  SWARM_STAGE_CREDIT_ANNOTATION_ACTION_CLASS,
  SWARM_STAGE_LABEL,
} from '@proompteng/agent-contracts/swarm-contracts'

import type {
  ActionSloBudgetActionClass,
  RepairBidAdmissionState,
  StageClearanceStage,
  StageCreditLedger,
  TerminalDebtCohort,
  TerminalDebtCohortClass,
  TerminalDebtCohortState,
  TerminalDebtCompactionLedger,
  TerminalDebtCompactionMode,
  TerminalDebtGateEffect,
  TerminalDebtSourceWindow,
  TerminalDebtSummary,
  TerminalDebtSummaryByClass,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import type { ReadyTruthArbiter } from '~/server/control-plane-status-types'
import type { ControlPlaneControllerWitnessQuorum } from '~/server/control-plane-status-types'
import type { ControlPlaneWatchReliability } from '~/server/control-plane-status-types'

export const TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT =
  'docs/agents/designs/189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.terminal-debt-compaction-ledger.v1' as const
const DEFAULT_TTL_SECONDS = 120
const DEFAULT_ACTIVE_WINDOW_MINUTES = 15
const RETAINED_AUDIT_DAYS = 7
const ROLLBACK_MODE_TARGET = 'JANGAR_TERMINAL_DEBT_COMPACTION_MODE=observe'
const ROLLBACK_DISABLE_TARGET = 'JANGAR_TERMINAL_DEBT_COMPACTION_ENABLED=false'

const GOVERNING_DESIGN_REFS = [
  TERMINAL_DEBT_COMPACTION_DESIGN_ARTIFACT,
  'docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md',
  'docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

const STAGE_VALUES = new Set<StageClearanceStage>([
  'serve',
  'discover',
  'plan',
  'implement',
  'verify',
  'repair',
  'deployer',
  'torghut',
])

const ACTION_CLASS_VALUES = new Set<ActionSloBudgetActionClass>([
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
])

const TERMINAL_FAILURE_PHASES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled'])
const TERMINAL_SUCCESS_PHASES = new Set(['succeeded', 'completed', 'complete'])

export type TerminalDebtCompactionEvidence = {
  agentRuns: TerminalDebtAgentRun[]
  jobs: TerminalDebtJob[]
  pods: TerminalDebtPod[]
  collectionErrors: string[]
}

export type TerminalDebtCondition = {
  type: string | null
  status: string | null
  reason: string | null
  lastTransitionTime: string | null
  message?: string | null
}

export type TerminalDebtMetadata = {
  name: string
  namespace: string | null
  generation: number | null
  labels: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp: string | null
}

export type TerminalDebtAgentRun = {
  metadata: TerminalDebtMetadata
  spec: {
    parameters: Record<string, string>
    agentRefName: string | null
    implementationSpecRefName: string | null
    runtimeType: string | null
  }
  status: {
    phase: string | null
    reason: string | null
    message: string | null
    startedAt: string | null
    finishedAt: string | null
    conditions: TerminalDebtCondition[]
  }
}

export type TerminalDebtJob = {
  metadata: TerminalDebtMetadata
  status: {
    active: number | null
    failed: number | null
    startTime: string | null
    completionTime: string | null
    conditions: TerminalDebtCondition[]
  }
}

export type TerminalDebtContainerState = {
  waiting?: {
    reason: string | null
    message: string | null
  }
  terminated?: {
    reason: string | null
    message: string | null
    exitCode: number | null
  }
  running?: boolean
}

export type TerminalDebtContainerStatus = {
  name: string
  image: string | null
  image_id?: string | null
  ready: boolean
  state: TerminalDebtContainerState
}

export type TerminalDebtPod = {
  metadata: TerminalDebtMetadata
  status: {
    phase: string | null
    conditions: TerminalDebtCondition[]
    containerStatuses: TerminalDebtContainerStatus[]
  }
}

export type TerminalDebtCompactionInput = TerminalDebtCompactionEvidence & {
  now: Date
  namespace: string
  workflows: WorkflowsReliabilityStatus
  watchReliability: ControlPlaneWatchReliability
  controllerWitness: ControlPlaneControllerWitnessQuorum
  stageCreditLedger: StageCreditLedger | null
  readyTruthArbiter: ReadyTruthArbiter
  repairBidAdmission: RepairBidAdmissionState
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

type TerminalDebtItem = {
  class: TerminalDebtCohortClass
  stage: StageClearanceStage | 'unknown'
  actionClass: ActionSloBudgetActionClass | 'unknown'
  state: TerminalDebtCohortState
  firstSeenAt: string
  lastSeenAt: string
  expiresActiveAt: string
  retainedUntil: string
  reasonCodes: string[]
  representativeRef: string
  activeGateEffect: TerminalDebtGateEffect
  valueGates: string[]
}

export const emptyTerminalDebtEvidence = (): TerminalDebtCompactionEvidence => ({
  agentRuns: [],
  jobs: [],
  pods: [],
  collectionErrors: [],
})

export const resolveTerminalDebtCompactionMode = (env: NodeJS.ProcessEnv = process.env): TerminalDebtCompactionMode => {
  const normalized = env.JANGAR_TERMINAL_DEBT_COMPACTION_MODE?.trim().toLowerCase()
  if (normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') return normalized
  return 'observe'
}

export const isTerminalDebtCompactionEnabled = (env: NodeJS.ProcessEnv = process.env) => {
  const normalized = env.JANGAR_TERMINAL_DEBT_COMPACTION_ENABLED?.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const addDays = (value: Date, days: number) => addSeconds(value, days * 24 * 60 * 60)

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const uniqueReasons = (values: Array<string | null | undefined>) => uniqueStrings(values).map(normalizeReason)

const parseDate = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

const maxDate = (dates: Date[]) => new Date(Math.max(...dates.map((date) => date.getTime())))

const minDate = (dates: Date[]) => new Date(Math.min(...dates.map((date) => date.getTime())))

const normalizeStage = (value: string | null | undefined): StageClearanceStage | 'unknown' => {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  return normalized && STAGE_VALUES.has(normalized as StageClearanceStage)
    ? (normalized as StageClearanceStage)
    : 'unknown'
}

const normalizeActionClass = (value: string | null | undefined): ActionSloBudgetActionClass | 'unknown' => {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  return normalized && ACTION_CLASS_VALUES.has(normalized as ActionSloBudgetActionClass)
    ? (normalized as ActionSloBudgetActionClass)
    : 'unknown'
}

const defaultActionClassForStage = (stage: StageClearanceStage | 'unknown'): ActionSloBudgetActionClass | 'unknown' => {
  if (stage === 'serve') return 'serve_readonly'
  if (stage === 'repair') return 'dispatch_repair'
  if (stage === 'deployer') return 'deploy_widen'
  if (stage === 'torghut') return 'torghut_observe'
  if (stage === 'discover' || stage === 'plan' || stage === 'implement' || stage === 'verify') return 'dispatch_normal'
  return 'unknown'
}

const conditionReasons = (conditions: TerminalDebtCondition[]) =>
  uniqueReasons(conditions.flatMap((condition) => [condition.reason, condition.message]))

const terminalConditionAt = (conditions: TerminalDebtCondition[]) => {
  const timestamps = conditions
    .filter(
      (condition) => condition.type === 'Succeeded' || condition.type === 'Complete' || condition.type === 'Failed',
    )
    .map((condition) => parseDate(condition.lastTransitionTime))
    .filter((date): date is Date => date !== null)
  return timestamps.length > 0 ? maxDate(timestamps) : null
}

const isCleanWorkflowWindow = (workflows: WorkflowsReliabilityStatus) =>
  workflows.data_confidence === 'high' &&
  workflows.recent_failed_jobs === 0 &&
  workflows.backoff_limit_exceeded_jobs === 0

const isFreshForActiveWindow = (input: {
  now: Date
  observedAt: Date | null
  activeWindowMs: number
  workflows: WorkflowsReliabilityStatus
}) => {
  if (!input.observedAt) return true
  if (input.now.getTime() - input.observedAt.getTime() <= input.activeWindowMs) return true
  return !isCleanWorkflowWindow(input.workflows)
}

const toWindowDates = (input: { now: Date; observedAt: Date | null; activeWindowMs: number }) => {
  const observedAt = input.observedAt ?? input.now
  return {
    firstSeenAt: observedAt.toISOString(),
    lastSeenAt: observedAt.toISOString(),
    expiresActiveAt: new Date(observedAt.getTime() + input.activeWindowMs).toISOString(),
    retainedUntil: addDays(observedAt, RETAINED_AUDIT_DAYS).toISOString(),
  }
}

const labelsAndAnnotations = (resource: TerminalDebtAgentRun | TerminalDebtJob | TerminalDebtPod) => ({
  labels: resource.metadata.labels ?? {},
  annotations: resource.metadata.annotations ?? {},
})

const resolveStageAndAction = (resource: TerminalDebtAgentRun | TerminalDebtJob | TerminalDebtPod) => {
  const { labels, annotations } = labelsAndAnnotations(resource)
  const parameters = 'spec' in resource && 'parameters' in resource.spec ? resource.spec.parameters : {}
  const stage = normalizeStage(
    parameters.stage ?? parameters.swarmStage ?? labels[SWARM_STAGE_LABEL] ?? annotations[SWARM_STAGE_LABEL],
  )
  const actionClass = normalizeActionClass(
    parameters.swarmStageClearanceActionClass ??
      parameters.swarmActionClass ??
      annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS] ??
      annotations[SWARM_STAGE_CREDIT_ANNOTATION_ACTION_CLASS],
  )

  return {
    stage,
    actionClass: actionClass === 'unknown' ? defaultActionClassForStage(stage) : actionClass,
  }
}

const agentRunRef = (agentRun: TerminalDebtAgentRun) =>
  `agentrun:${agentRun.metadata.namespace ?? 'unknown'}:${agentRun.metadata.name}`

const jobRef = (job: TerminalDebtJob) => `job:${job.metadata.namespace ?? 'unknown'}:${job.metadata.name}`

const podRef = (pod: TerminalDebtPod) => `pod:${pod.metadata.namespace ?? 'unknown'}:${pod.metadata.name}`

const agentRunItems = (input: TerminalDebtCompactionInput, activeWindowMs: number): TerminalDebtItem[] =>
  input.agentRuns.flatMap((agentRun) => {
    const phase = normalizeReason(agentRun.status.phase ?? 'unknown')
    if (TERMINAL_SUCCESS_PHASES.has(phase)) return []

    const failed = TERMINAL_FAILURE_PHASES.has(phase)
    if (!failed) return []

    const observedAt =
      parseDate(agentRun.status.finishedAt) ??
      terminalConditionAt(agentRun.status.conditions) ??
      parseDate(agentRun.status.startedAt) ??
      parseDate(agentRun.metadata.creationTimestamp)
    const active = isFreshForActiveWindow({ now: input.now, observedAt, activeWindowMs, workflows: input.workflows })
    const stageAndAction = resolveStageAndAction(agentRun)
    const reasonCodes = uniqueReasons([
      'agentrun_failed',
      `agentrun_phase:${phase}`,
      active ? 'agentrun_failure_active_window' : 'agentrun_failure_retained_audit',
      agentRun.status.reason,
      agentRun.status.message,
      ...conditionReasons(agentRun.status.conditions),
    ])

    return [
      {
        class: 'agentrun',
        ...stageAndAction,
        state: active ? 'active' : 'retained_audit',
        ...toWindowDates({ now: input.now, observedAt, activeWindowMs }),
        reasonCodes,
        representativeRef: agentRunRef(agentRun),
        activeGateEffect: active ? 'hold' : 'audit_only',
        valueGates: ['failed_agentrun_rate', 'ready_status_truth', 'handoff_evidence_quality'],
      },
    ]
  })

const isFailedJob = (job: TerminalDebtJob) =>
  (job.status.failed ?? 0) > 0 ||
  job.status.conditions.some((condition) => condition.type === 'Failed' && condition.status === 'True')

const jobItems = (input: TerminalDebtCompactionInput, activeWindowMs: number): TerminalDebtItem[] =>
  input.jobs.flatMap((job) => {
    if (!isFailedJob(job)) return []

    const observedAt =
      parseDate(job.status.completionTime) ??
      terminalConditionAt(job.status.conditions) ??
      parseDate(job.status.startTime) ??
      parseDate(job.metadata.creationTimestamp)
    const active = isFreshForActiveWindow({ now: input.now, observedAt, activeWindowMs, workflows: input.workflows })
    const stageAndAction = resolveStageAndAction(job)
    const reasonCodes = uniqueReasons([
      'job_failed',
      active ? 'job_failure_active_window' : 'job_failure_retained_audit',
      ...conditionReasons(job.status.conditions),
    ])

    return [
      {
        class: 'job',
        ...stageAndAction,
        state: active ? 'active' : 'retained_audit',
        ...toWindowDates({ now: input.now, observedAt, activeWindowMs }),
        reasonCodes,
        representativeRef: jobRef(job),
        activeGateEffect: active ? 'hold' : 'audit_only',
        valueGates: ['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth'],
      },
    ]
  })

const failedContainerReasons = (pod: TerminalDebtPod) =>
  uniqueReasons(
    pod.status.containerStatuses.flatMap((container) => [
      container.state.terminated?.reason,
      container.state.terminated?.message,
      container.state.terminated?.exitCode && container.state.terminated.exitCode > 0
        ? `container_exit_${container.state.terminated.exitCode}`
        : null,
    ]),
  )

const isFailedPod = (pod: TerminalDebtPod) =>
  normalizeReason(pod.status.phase ?? '') === 'failed' ||
  pod.status.containerStatuses.some((container) => {
    const exitCode = container.state.terminated?.exitCode
    return typeof exitCode === 'number' && exitCode > 0
  })

const podItems = (input: TerminalDebtCompactionInput, activeWindowMs: number): TerminalDebtItem[] =>
  input.pods.flatMap((pod) => {
    if (!isFailedPod(pod)) return []

    const observedAt = parseDate(pod.metadata.creationTimestamp)
    const active = isFreshForActiveWindow({ now: input.now, observedAt, activeWindowMs, workflows: input.workflows })
    const stageAndAction = resolveStageAndAction(pod)
    const reasonCodes = uniqueReasons([
      'pod_failed',
      active ? 'pod_failure_active_window' : 'pod_failure_retained_audit',
      normalizeReason(pod.status.phase ?? 'unknown'),
      ...failedContainerReasons(pod),
      ...conditionReasons(pod.status.conditions),
    ])

    return [
      {
        class: 'pod',
        ...stageAndAction,
        state: active ? 'active' : 'retained_audit',
        ...toWindowDates({ now: input.now, observedAt, activeWindowMs }),
        reasonCodes,
        representativeRef: podRef(pod),
        activeGateEffect: active ? 'hold' : 'audit_only',
        valueGates: ['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth'],
      },
    ]
  })

const collectionErrorItems = (input: TerminalDebtCompactionInput, activeWindowMs: number): TerminalDebtItem[] =>
  input.collectionErrors.map((error) => ({
    class: 'source_ingest',
    stage: 'unknown',
    actionClass: 'unknown',
    state: 'pending_settlement',
    ...toWindowDates({ now: input.now, observedAt: input.now, activeWindowMs }),
    reasonCodes: uniqueReasons(['terminal_debt_collection_error', error]),
    representativeRef: `terminal-debt-collection:${hashJson(error, 8)}`,
    activeGateEffect: 'hold',
    valueGates: ['ready_status_truth', 'handoff_evidence_quality'],
  }))

const itemStateRank = (state: TerminalDebtCohortState) => {
  if (state === 'active') return 0
  if (state === 'pending_settlement') return 1
  if (state === 'settled') return 2
  if (state === 'retained_audit') return 3
  return 4
}

const buildCohorts = (items: TerminalDebtItem[]): TerminalDebtCohort[] => {
  const groups = new Map<string, TerminalDebtItem[]>()
  for (const item of items) {
    const reasonKey = item.reasonCodes.toSorted().join(',')
    const key = [item.class, item.stage, item.actionClass, item.state, item.activeGateEffect, reasonKey].join('|')
    groups.set(key, [...(groups.get(key) ?? []), item])
  }

  return [...groups.values()]
    .map((entries): TerminalDebtCohort => {
      const first = entries[0]
      const firstSeenAt = minDate(entries.map((entry) => new Date(entry.firstSeenAt))).toISOString()
      const lastSeenAt = maxDate(entries.map((entry) => new Date(entry.lastSeenAt))).toISOString()
      const expiresActiveAt = maxDate(entries.map((entry) => new Date(entry.expiresActiveAt))).toISOString()
      const retainedUntil = maxDate(entries.map((entry) => new Date(entry.retainedUntil))).toISOString()
      const reasonCodes = uniqueStrings(entries.flatMap((entry) => entry.reasonCodes)).toSorted()
      const representativeRefs = uniqueStrings(entries.map((entry) => entry.representativeRef)).slice(0, 5)
      const valueGates = uniqueStrings(entries.flatMap((entry) => entry.valueGates)).toSorted()
      const cohortHash = hashJson({
        class: first.class,
        stage: first.stage,
        action_class: first.actionClass,
        state: first.state,
        reason_codes: reasonCodes,
        representative_refs: representativeRefs,
      })
      const cohortId = `terminal-debt-cohort:${first.class}:${first.state}:${cohortHash}`

      return {
        cohort_id: cohortId,
        class: first.class,
        stage: first.stage,
        action_class: first.actionClass,
        state: first.state,
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        expires_active_at: expiresActiveAt,
        retained_until: retainedUntil,
        count: entries.length,
        reason_codes: reasonCodes,
        representative_refs: representativeRefs,
        compacted_artifact_ref: `terminal-debt-artifact:${cohortHash}`,
        active_gate_effect: first.activeGateEffect,
        value_gates: valueGates,
      }
    })
    .toSorted((left, right) => {
      const state = itemStateRank(left.state) - itemStateRank(right.state)
      if (state !== 0) return state
      return left.cohort_id.localeCompare(right.cohort_id)
    })
}

const byClass = (cohorts: TerminalDebtCohort[]): TerminalDebtSummaryByClass[] => {
  const counts = new Map<TerminalDebtCohortClass, number>()
  for (const cohort of cohorts) {
    counts.set(cohort.class, (counts.get(cohort.class) ?? 0) + cohort.count)
  }

  return [...counts.entries()]
    .map(([className, count]) => ({ class: className, count }))
    .toSorted((left, right) => left.class.localeCompare(right.class))
}

const buildSummary = (cohorts: TerminalDebtCohort[]): TerminalDebtSummary => ({
  count: cohorts.reduce((total, cohort) => total + cohort.count, 0),
  by_class: byClass(cohorts),
  reason_codes: uniqueStrings(cohorts.flatMap((cohort) => cohort.reason_codes)).toSorted(),
  representative_refs: uniqueStrings(cohorts.flatMap((cohort) => cohort.representative_refs)).slice(0, 8),
  value_gates: uniqueStrings(cohorts.flatMap((cohort) => cohort.value_gates)).toSorted(),
})

const sourceWindow = (input: {
  sourceClass: TerminalDebtCohortClass
  windowMinutes: number
  observedCount: number
  cohorts: TerminalDebtCohort[]
  collectionError: string | null
}): TerminalDebtSourceWindow => {
  const sourceCohorts = input.cohorts.filter((cohort) => cohort.class === input.sourceClass)
  const activeDebtCount = sourceCohorts
    .filter((cohort) => cohort.state === 'active' || cohort.state === 'pending_settlement')
    .reduce((total, cohort) => total + cohort.count, 0)
  const retainedAuditCount = sourceCohorts
    .filter((cohort) => cohort.state === 'retained_audit')
    .reduce((total, cohort) => total + cohort.count, 0)

  return {
    source_class: input.sourceClass,
    window_minutes: input.windowMinutes,
    observed_count: input.observedCount,
    active_debt_count: activeDebtCount,
    retained_audit_count: retainedAuditCount,
    collection_error: input.collectionError,
    evidence_refs: uniqueStrings(sourceCohorts.flatMap((cohort) => cohort.representative_refs)).slice(0, 5),
  }
}

const collectionErrorFor = (errors: string[], label: string) =>
  errors.find((error) => error.startsWith(`${label} terminal debt collection failed:`)) ?? null

const strictestTerminalDebtDecision = (cohorts: TerminalDebtCohort[]) => {
  if (cohorts.some((cohort) => cohort.active_gate_effect === 'block')) return 'block' as const
  if (cohorts.some((cohort) => cohort.active_gate_effect === 'hold')) return 'hold' as const
  return 'allow' as const
}

export const buildTerminalDebtCompactionLedger = (input: TerminalDebtCompactionInput): TerminalDebtCompactionLedger => {
  const windowMinutes =
    input.workflows.window_minutes > 0 ? input.workflows.window_minutes : DEFAULT_ACTIVE_WINDOW_MINUTES
  const activeWindowMs = windowMinutes * 60 * 1000
  const freshUntil = addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
  const mode = resolveTerminalDebtCompactionMode()
  const items = [
    ...agentRunItems(input, activeWindowMs),
    ...jobItems(input, activeWindowMs),
    ...podItems(input, activeWindowMs),
    ...collectionErrorItems(input, activeWindowMs),
  ]
  const cohorts = buildCohorts(items)
  const activeCohorts = cohorts.filter((cohort) => cohort.state === 'active' || cohort.state === 'pending_settlement')
  const retainedAuditCohorts = cohorts.filter((cohort) => cohort.state === 'retained_audit')
  const activeDebtSummary = buildSummary(activeCohorts)
  const retainedAuditSummary = buildSummary(retainedAuditCohorts)
  const decision = strictestTerminalDebtDecision(activeCohorts)
  const activeReasonCodes = activeDebtSummary.reason_codes
  const repairOutcomeEscrows = input.torghutConsumerEvidence.repair_outcome_escrows ?? []
  const heldActionClasses: ActionSloBudgetActionClass[] =
    activeDebtSummary.count > 0 ? ['dispatch_normal', 'deploy_widen', 'merge_ready'] : []
  const ledgerHash = hashJson({
    namespace: input.namespace,
    active_debt_count: activeDebtSummary.count,
    retained_audit_count: retainedAuditSummary.count,
    cohorts: cohorts.map((cohort) => [cohort.cohort_id, cohort.count]),
    workflow_window: input.workflows.window_minutes,
  })
  const ledgerId = `terminal-debt-ledger:${input.namespace}:${ledgerHash}`

  return {
    schema_version: SCHEMA_VERSION,
    ledger_id: ledgerId,
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    evidence_mode: mode,
    source_windows: [
      sourceWindow({
        sourceClass: 'agentrun',
        windowMinutes,
        observedCount: input.agentRuns.length,
        cohorts,
        collectionError: collectionErrorFor(input.collectionErrors, 'AgentRun'),
      }),
      sourceWindow({
        sourceClass: 'job',
        windowMinutes,
        observedCount: input.jobs.length,
        cohorts,
        collectionError: collectionErrorFor(input.collectionErrors, 'Job'),
      }),
      sourceWindow({
        sourceClass: 'pod',
        windowMinutes,
        observedCount: input.pods.length,
        cohorts,
        collectionError: collectionErrorFor(input.collectionErrors, 'Pod'),
      }),
    ],
    active_debt_summary: activeDebtSummary,
    retained_audit_summary: retainedAuditSummary,
    cohorts,
    repair_outcome_escrows: repairOutcomeEscrows,
    scheduler_contract: {
      status: decision,
      mode,
      ledger_ref: ledgerId,
      active_debt_count: activeDebtSummary.count,
      retained_audit_count: retainedAuditSummary.count,
      would_hold_action_classes: heldActionClasses,
      reason_codes: activeReasonCodes,
    },
    deployer_contract: {
      status: decision,
      ledger_ref: ledgerId,
      active_debt_count: activeDebtSummary.count,
      retained_audit_count: retainedAuditSummary.count,
      merge_ready_action: decision === 'allow' ? 'allow' : 'hold',
      deploy_widen_action: decision === 'allow' ? 'allow' : 'hold',
      reason_codes: activeReasonCodes,
      evidence_refs: uniqueStrings([
        input.stageCreditLedger?.ledger_id,
        input.readyTruthArbiter.verdict_id,
        input.controllerWitness.quorum_id,
        input.torghutConsumerEvidence.receipt_id,
        input.repairBidAdmission.torghut_settlement_ledger_ref,
        input.torghutConsumerEvidence.repair_outcome_dividend_ledger_id,
        ...repairOutcomeEscrows.map((escrow) => escrow.escrow_id),
        ...activeDebtSummary.representative_refs,
      ]),
    },
    rollback_contract: {
      mode_target: ROLLBACK_MODE_TARGET,
      disable_target: ROLLBACK_DISABLE_TARGET,
      safe_without_database_migration: true,
      notes: [
        'observe-mode ledger does not mutate Kubernetes resources, database rows, or scheduler admission',
        'retained audit cohorts remain visible after rollback but stop influencing downstream consumers',
      ],
    },
  }
}
