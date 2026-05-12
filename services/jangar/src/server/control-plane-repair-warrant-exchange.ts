import { createHash } from 'node:crypto'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  RepairWarrantDimension,
  RepairWarrantExchange,
  RepairWarrantRecord,
  RepairWarrantRiskTier,
  RepairWarrantScheduleDebtAttempt,
  RepairWarrantScheduleDebtAttemptResult,
  RepairWarrantScheduleDebtLane,
  RepairWarrantScheduleDebtWindow,
  RepairWarrantSuppressedCandidate,
  SourceRolloutTruthExchange,
} from '~/data/agents-control-plane'
import type { ControlPlaneRolloutHealth, ControlPlaneWatchReliability } from '~/server/control-plane-status-types'
import type { KubeGateway, KubeGatewayCondition, KubeGatewayJob } from '~/server/kube-gateway'
import { asRecord, asString, readNested } from '~/server/primitives-http'

export const REPAIR_WARRANT_EXCHANGE_DESIGN_ARTIFACT =
  'docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md'

export const SCHEDULE_DEBT_ANNOTATION_LANE = 'jangar.proompteng.ai/schedule-debt-lane'
export const SCHEDULE_DEBT_ANNOTATION_SOURCE_REF = 'jangar.proompteng.ai/schedule-debt-source-ref'
export const SCHEDULE_DEBT_ANNOTATION_IMAGE_REF = 'jangar.proompteng.ai/schedule-debt-image-ref'
export const SCHEDULE_DEBT_ANNOTATION_OBJECTIVE_REF = 'jangar.proompteng.ai/schedule-debt-objective-ref'

const PRODUCER_REVISION = '2026-05-07-repair-warrant-exchange-observe-v1'
const DEFAULT_FRESHNESS_MS = 60_000
const SCHEDULE_DEBT_WINDOW_MINUTES = 4 * 60
const SCHEDULE_DEBT_ERROR_MARGIN = 2
const SCHEDULE_LABEL = 'schedules.proompteng.ai/schedule'
const SWARM_NAME_LABEL = 'swarm.proompteng.ai/name'
const SWARM_STAGE_LABEL = 'swarm.proompteng.ai/stage'
const RUNTIME_DIGEST_ANNOTATION = 'swarm.proompteng.ai/runtime-kit-set-digest'
const ADMISSION_PRODUCER_REVISION_ANNOTATION = 'swarm.proompteng.ai/admission-producer-revision'
const SOURCE_HEAD_ANNOTATION = 'jangar.proompteng.ai/source-head-sha'
const GITOPS_REVISION_ANNOTATION = 'jangar.proompteng.ai/gitops-revision'

export type RepairScheduleAttemptEvidence = {
  lane: string
  sourceRef: string | null
  imageRef: string | null
  objectiveRef: string | null
  result: RepairWarrantScheduleDebtAttemptResult
  observedAt: string
  jobRef: string
  reasonCodes?: string[]
}

export type RepairScheduleAttemptCollection = {
  attempts: RepairScheduleAttemptEvidence[]
  collectionErrors: string[]
}

export type RepairScheduleAttemptCollectionInput = {
  now: Date
  namespaces: string[]
  kube: KubeGateway
}

export type RepairWarrantExchangeInput = {
  now: Date
  namespace: string
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  actionSloBudgets: ActionSloBudget[]
  torghutActionSloBudgets: ActionSloBudget[]
  watchReliability: ControlPlaneWatchReliability
  rolloutHealth: ControlPlaneRolloutHealth
  scheduleAttempts?: RepairScheduleAttemptEvidence[]
  scheduleCollectionErrors?: string[]
}

type RepairCandidate = {
  repairDimension: RepairWarrantDimension
  repairCode: string
  accountLabel: string
  reasonCodes: string[]
  evidenceRefs: string[]
  sourceBudgetId: string | null
  expectedUnblockValue: number
  riskTier: RepairWarrantRiskTier
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addMs = (value: Date, ms: number) => new Date(value.getTime() + ms)

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const firstNonEmpty = (values: Array<string | undefined | null>) => {
  for (const value of values) {
    const normalized = normalizeNonEmpty(value)
    if (normalized) return normalized
  }
  return null
}

export const buildScheduleDebtAnnotations = ({
  schedule,
  scheduleName,
  namespace,
  image,
}: {
  schedule: unknown
  scheduleName: string
  namespace: string
  image: string
}) => {
  const annotations = asRecord(readNested(schedule, ['metadata', 'annotations'])) ?? {}
  const targetRef = asRecord(readNested(schedule, ['spec', 'targetRef'])) ?? {}
  const targetKind = asString(targetRef.kind)
  const targetName = asString(targetRef.name)
  const targetNamespace = asString(targetRef.namespace) ?? namespace

  return Object.fromEntries(
    [
      [SCHEDULE_DEBT_ANNOTATION_LANE, scheduleName],
      [
        SCHEDULE_DEBT_ANNOTATION_SOURCE_REF,
        firstNonEmpty([
          process.env.JANGAR_SOURCE_HEAD_SHA,
          process.env.JANGAR_COMMIT,
          process.env.GIT_COMMIT,
          process.env.COMMIT_SHA,
          process.env.JANGAR_GITOPS_REVISION,
        ]),
      ],
      [
        SCHEDULE_DEBT_ANNOTATION_IMAGE_REF,
        firstNonEmpty([
          asString(annotations[RUNTIME_DIGEST_ANNOTATION]),
          asString(annotations[ADMISSION_PRODUCER_REVISION_ANNOTATION]),
          image,
        ]),
      ],
      [
        SCHEDULE_DEBT_ANNOTATION_OBJECTIVE_REF,
        targetKind && targetName ? `${targetKind}:${targetNamespace}:${targetName}` : scheduleName,
      ],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const parseIsoMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const valid = values
    .map(parseIsoMs)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return valid.length > 0 ? new Date(valid[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const conditionIsTrue = (condition: KubeGatewayCondition, type: string) =>
  condition.type === type && condition.status === 'True'

const latestConditionTime = (conditions: KubeGatewayCondition[]) => {
  const times = conditions
    .map((condition) => parseIsoMs(condition.lastTransitionTime))
    .filter((value): value is number => value !== null)
  return times.length > 0 ? Math.max(...times) : null
}

const jobResult = (job: KubeGatewayJob): RepairWarrantScheduleDebtAttemptResult => {
  if (job.status.conditions.some((condition) => conditionIsTrue(condition, 'Complete'))) return 'success'
  if (job.status.conditions.some((condition) => conditionIsTrue(condition, 'Failed'))) return 'error'
  if ((job.status.failed ?? 0) > 0) return 'error'
  if ((job.status.active ?? 0) > 0) return 'running'
  if (job.status.completionTime) return 'success'
  return 'unknown'
}

const jobObservedAt = (job: KubeGatewayJob, now: Date) => {
  const timestamp =
    parseIsoMs(job.status.completionTime) ??
    latestConditionTime(job.status.conditions) ??
    parseIsoMs(job.status.startTime) ??
    parseIsoMs(job.metadata.creationTimestamp) ??
    now.getTime()
  return new Date(timestamp).toISOString()
}

const jobReasonCodes = (job: KubeGatewayJob, result: RepairWarrantScheduleDebtAttemptResult) => {
  const reasons = job.status.conditions
    .map((condition) => normalizeNonEmpty(condition.reason))
    .filter((reason): reason is string => Boolean(reason))
  if (reasons.length > 0) return uniqueStrings(reasons)
  if (result === 'error') return ['job_failed']
  if (result === 'success') return ['job_succeeded']
  if (result === 'running') return ['job_running']
  return ['job_status_unknown']
}

const readMetadataValue = (
  job: KubeGatewayJob,
  annotationKey: string,
  labelKey: string | null = null,
): string | null => {
  const annotations = job.metadata.annotations ?? {}
  const labels = job.metadata.labels
  return normalizeNonEmpty(annotations[annotationKey]) ?? (labelKey ? normalizeNonEmpty(labels[labelKey]) : null)
}

const jobLane = (job: KubeGatewayJob) => {
  const annotationLane = readMetadataValue(job, SCHEDULE_DEBT_ANNOTATION_LANE)
  if (annotationLane) return annotationLane
  const schedule = normalizeNonEmpty(job.metadata.labels[SCHEDULE_LABEL])
  if (schedule) return schedule
  const swarm = normalizeNonEmpty(job.metadata.labels[SWARM_NAME_LABEL])
  const stage = normalizeNonEmpty(job.metadata.labels[SWARM_STAGE_LABEL])
  if (swarm && stage) return `${swarm}:${stage}`
  return job.metadata.name
}

const jobObjectiveRef = (job: KubeGatewayJob) => {
  const explicit = readMetadataValue(job, SCHEDULE_DEBT_ANNOTATION_OBJECTIVE_REF)
  if (explicit) return explicit
  const swarm = normalizeNonEmpty(job.metadata.labels[SWARM_NAME_LABEL])
  const stage = normalizeNonEmpty(job.metadata.labels[SWARM_STAGE_LABEL])
  if (swarm && stage) return `swarm-stage:${swarm}:${stage}`
  return null
}

export const collectRepairScheduleAttempts = async ({
  now,
  namespaces,
  kube,
}: RepairScheduleAttemptCollectionInput): Promise<RepairScheduleAttemptCollection> => {
  const attempts: RepairScheduleAttemptEvidence[] = []
  const collectionErrors: string[] = []
  const uniqueNamespaces = uniqueStrings(namespaces.length > 0 ? namespaces : ['agents'])

  for (const namespace of uniqueNamespaces) {
    try {
      const jobs = await kube.listJobs(namespace, SCHEDULE_LABEL)
      attempts.push(
        ...jobs.map((job) => {
          const result = jobResult(job)
          const sourceRef =
            readMetadataValue(job, SCHEDULE_DEBT_ANNOTATION_SOURCE_REF) ??
            readMetadataValue(job, SOURCE_HEAD_ANNOTATION) ??
            readMetadataValue(job, GITOPS_REVISION_ANNOTATION)
          return {
            lane: jobLane(job),
            sourceRef,
            imageRef:
              readMetadataValue(job, SCHEDULE_DEBT_ANNOTATION_IMAGE_REF) ??
              readMetadataValue(job, RUNTIME_DIGEST_ANNOTATION),
            objectiveRef: jobObjectiveRef(job),
            result,
            observedAt: jobObservedAt(job, now),
            jobRef: `job:${job.metadata.namespace ?? namespace}:${job.metadata.name}`,
            reasonCodes: jobReasonCodes(job, result),
          }
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      collectionErrors.push(`${namespace}: ${message}`)
    }
  }

  return { attempts, collectionErrors }
}

const attemptSignature = (attempt: RepairWarrantScheduleDebtAttempt) =>
  attempt.signature_complete
    ? `${attempt.lane}\u0000${attempt.source_ref}\u0000${attempt.image_ref}\u0000${attempt.objective_ref}`
    : null

const buildAttempt = (attempt: RepairScheduleAttemptEvidence): RepairWarrantScheduleDebtAttempt => {
  const sourceRef = normalizeNonEmpty(attempt.sourceRef)
  const imageRef = normalizeNonEmpty(attempt.imageRef)
  const objectiveRef = normalizeNonEmpty(attempt.objectiveRef)
  const signatureComplete = Boolean(sourceRef && imageRef && objectiveRef)
  const reasonCodes = uniqueStrings((attempt.reasonCodes ?? []).map(normalizeReason))
  return {
    attempt_id: `schedule-debt-attempt:${hashJson({
      lane: attempt.lane,
      source_ref: sourceRef,
      image_ref: imageRef,
      objective_ref: objectiveRef,
      result: attempt.result,
      observed_at: attempt.observedAt,
      job_ref: attempt.jobRef,
    })}`,
    lane: attempt.lane,
    source_ref: sourceRef,
    image_ref: imageRef,
    objective_ref: objectiveRef,
    signature_complete: signatureComplete,
    result: attempt.result,
    observed_at: attempt.observedAt,
    job_ref: attempt.jobRef,
    supersedes_attempt_ids: [],
    superseded_by_attempt_id: null,
    reason_codes: reasonCodes.length > 0 ? reasonCodes : [attempt.result],
  }
}

export const buildScheduleDebtWindow = ({
  now,
  attempts,
  collectionErrors = [],
}: {
  now: Date
  attempts: RepairScheduleAttemptEvidence[]
  collectionErrors?: string[]
}): RepairWarrantScheduleDebtWindow => {
  const windowStartMs = now.getTime() - SCHEDULE_DEBT_WINDOW_MINUTES * 60 * 1000
  const windowAttempts = attempts
    .map(buildAttempt)
    .filter((attempt) => {
      const observedMs = parseIsoMs(attempt.observed_at)
      return observedMs !== null && observedMs >= windowStartMs && observedMs <= now.getTime()
    })
    .sort((left, right) => left.lane.localeCompare(right.lane) || left.observed_at.localeCompare(right.observed_at))

  const attemptsById = new Map(windowAttempts.map((attempt) => [attempt.attempt_id, attempt]))
  const openErrorsBySignature = new Map<string, RepairWarrantScheduleDebtAttempt[]>()

  for (const attempt of windowAttempts) {
    const signature = attemptSignature(attempt)
    if (!signature) continue

    if (attempt.result === 'error') {
      const current = openErrorsBySignature.get(signature) ?? []
      current.push(attempt)
      openErrorsBySignature.set(signature, current)
      continue
    }

    if (attempt.result === 'success') {
      const openErrors = openErrorsBySignature.get(signature) ?? []
      for (const errorAttempt of openErrors) {
        const mutableError = attemptsById.get(errorAttempt.attempt_id)
        if (!mutableError || mutableError.superseded_by_attempt_id) continue
        mutableError.superseded_by_attempt_id = attempt.attempt_id
        attempt.supersedes_attempt_ids.push(mutableError.attempt_id)
      }
      openErrorsBySignature.set(signature, [])
    }
  }

  const lanes = Array.from(
    windowAttempts
      .reduce((byLane, attempt) => {
        const current = byLane.get(attempt.lane) ?? []
        current.push(attempt)
        byLane.set(attempt.lane, current)
        return byLane
      }, new Map<string, RepairWarrantScheduleDebtAttempt[]>())
      .entries(),
  )
    .map(([lane, laneAttempts]): RepairWarrantScheduleDebtLane => {
      const openErrorCount = laneAttempts.filter(
        (attempt) => attempt.result === 'error' && !attempt.superseded_by_attempt_id,
      ).length
      const supersededErrorCount = laneAttempts.filter(
        (attempt) => attempt.result === 'error' && attempt.superseded_by_attempt_id,
      ).length
      const successCount = laneAttempts.filter((attempt) => attempt.result === 'success').length
      const runningCount = laneAttempts.filter((attempt) => attempt.result === 'running').length
      const firebreakState = openErrorCount > SCHEDULE_DEBT_ERROR_MARGIN ? 'observe_only' : 'clear'
      return {
        lane,
        firebreak_state: firebreakState,
        open_error_count: openErrorCount,
        superseded_error_count: supersededErrorCount,
        success_count: successCount,
        running_count: runningCount,
        attempts: laneAttempts.sort((left, right) => left.observed_at.localeCompare(right.observed_at)),
        reason_codes: firebreakState === 'observe_only' ? ['schedule_debt_error_margin_exceeded'] : [],
      }
    })
    .sort((left, right) => left.lane.localeCompare(right.lane))

  const openErrorCount = lanes.reduce((total, lane) => total + lane.open_error_count, 0)
  const supersededErrorCount = lanes.reduce((total, lane) => total + lane.superseded_error_count, 0)
  const successCount = lanes.reduce((total, lane) => total + lane.success_count, 0)
  const runningCount = lanes.reduce((total, lane) => total + lane.running_count, 0)
  const firebreakState =
    collectionErrors.length > 0 || lanes.some((lane) => lane.firebreak_state === 'observe_only')
      ? 'observe_only'
      : 'clear'

  return {
    started_at: new Date(windowStartMs).toISOString(),
    expires_at: addMs(now, DEFAULT_FRESHNESS_MS).toISOString(),
    window_minutes: SCHEDULE_DEBT_WINDOW_MINUTES,
    open_error_count: openErrorCount,
    superseded_error_count: supersededErrorCount,
    success_count: successCount,
    running_count: runningCount,
    firebreak_state: firebreakState,
    lanes,
    collection_errors: collectionErrors,
  }
}

const repairDimensionForReason = (reason: string): RepairWarrantDimension => {
  const normalized = normalizeReason(reason)
  if (normalized.includes('tca') || normalized.includes('slippage') || normalized.includes('execution_quality')) {
    return 'execution_tca'
  }
  if (normalized.includes('market_context') || normalized.includes('provider_probe')) return 'market_context'
  if (normalized.includes('materialization')) return 'quant_materialization'
  if (normalized.includes('latest_store') || normalized.includes('latest_metrics')) return 'quant_latest_store'
  if (normalized.includes('ingestion') || normalized.includes('metrics_pipeline_lag')) return 'quant_ingestion'
  if (normalized.includes('alpha') || normalized.includes('hypothesis')) return 'alpha_readiness'
  if (normalized.includes('forecast')) return 'forecast_registry'
  return 'consumer_evidence'
}

const repairCodeForDimension = (dimension: RepairWarrantDimension) => `torghut.${dimension}`

const riskTierForDimension = (dimension: RepairWarrantDimension): RepairWarrantRiskTier => {
  if (dimension === 'execution_tca' || dimension === 'alpha_readiness') return 'high'
  if (dimension === 'market_context' || dimension === 'quant_ingestion') return 'medium'
  return 'low'
}

const expectedValueForDimension = (dimension: RepairWarrantDimension) => {
  const values: Record<RepairWarrantDimension, number> = {
    execution_tca: 0.9,
    market_context: 0.75,
    quant_ingestion: 0.7,
    quant_materialization: 0.65,
    quant_latest_store: 0.6,
    alpha_readiness: 0.85,
    forecast_registry: 0.55,
    consumer_evidence: 0.5,
  }
  return values[dimension]
}

const closureRequirementsForDimension = (dimension: RepairWarrantDimension) => {
  const byDimension: Record<RepairWarrantDimension, string[]> = {
    execution_tca: ['fresh execution TCA receipt inside the active observation epoch', 'slippage guardrail evidence'],
    market_context: ['fresh market-context evidence rows or closed-session deferral receipt'],
    quant_ingestion: ['live quant ingestion lag below the configured stage budget'],
    quant_materialization: ['live latest metrics materialization is fresh'],
    quant_latest_store: ['simulation latest metrics and stage rows are populated'],
    alpha_readiness: ['promotion-eligible hypothesis evidence after required data receipts are current'],
    forecast_registry: ['calibrated forecast registry is loaded and cited by Torghut proof floor'],
    consumer_evidence: ['Torghut consumer evidence receipt cites the repaired proof dimension'],
  }
  return byDimension[dimension]
}

const validationRefsForDimension = (dimension: RepairWarrantDimension) => {
  const common = ['GET /api/agents/control-plane/status?namespace=agents']
  if (dimension === 'execution_tca') return [...common, 'GET /trading/status execution_tca']
  if (dimension === 'market_context') return [...common, 'GET /trading/status market_context']
  if (dimension === 'forecast_registry') return [...common, 'GET /trading/status forecast']
  return [...common, 'GET /trading/status proof_floor']
}

const accountLabelForReason = (reason: string) => {
  const normalized = normalizeReason(reason)
  if (normalized.includes('sim')) return 'torghut-sim'
  if (normalized.includes('live')) return 'torghut-live'
  return 'torghut'
}

const candidateReasons = (input: RepairWarrantExchangeInput) => {
  const proofFloor = input.sourceRolloutTruthExchange.torghut_proof_floor
  const budgetReasons = input.torghutActionSloBudgets.flatMap((budget) => [
    ...budget.blocked_reasons,
    ...budget.downgrade_reasons,
    ...budget.required_repairs.map(normalizeReason),
  ])
  const reasons = uniqueStrings([...proofFloor.blockers, ...budgetReasons])
  if (reasons.length > 0) return reasons
  if (proofFloor.state === 'missing' || proofFloor.state === 'unknown') return ['torghut_consumer_evidence_missing']
  return []
}

const budgetForDimension = (budgets: ActionSloBudget[], dimension: RepairWarrantDimension) => {
  const reasonToken = dimension.replace('quant_', '')
  return (
    budgets.find((budget) =>
      [...budget.blocked_reasons, ...budget.downgrade_reasons, ...budget.required_repairs].some((reason) =>
        normalizeReason(reason).includes(reasonToken),
      ),
    ) ?? budgets.find((budget) => budget.action_class === 'dispatch_repair')
  )
}

const buildRepairCandidates = (input: RepairWarrantExchangeInput): RepairCandidate[] => {
  const proofFloor = input.sourceRolloutTruthExchange.torghut_proof_floor
  const reasons = candidateReasons(input)
  const byDimension = new Map<RepairWarrantDimension, RepairCandidate>()

  for (const reason of reasons) {
    const dimension = repairDimensionForReason(reason)
    const current = byDimension.get(dimension)
    const sourceBudget = budgetForDimension(input.actionSloBudgets, dimension)
    const evidenceRefs = uniqueStrings([
      proofFloor.proof_floor_ref,
      ...proofFloor.evidence_refs,
      ...(sourceBudget ? [sourceBudget.budget_id, ...sourceBudget.evidence_refs] : []),
    ])
    if (current) {
      current.reasonCodes = uniqueStrings([...current.reasonCodes, normalizeReason(reason)])
      current.evidenceRefs = uniqueStrings([...current.evidenceRefs, ...evidenceRefs])
      continue
    }
    byDimension.set(dimension, {
      repairDimension: dimension,
      repairCode: repairCodeForDimension(dimension),
      accountLabel: accountLabelForReason(reason),
      reasonCodes: [normalizeReason(reason)],
      evidenceRefs,
      sourceBudgetId: sourceBudget?.budget_id ?? null,
      expectedUnblockValue: expectedValueForDimension(dimension),
      riskTier: riskTierForDimension(dimension),
    })
  }

  return Array.from(byDimension.values()).sort((left, right) => {
    if (right.expectedUnblockValue !== left.expectedUnblockValue) {
      return right.expectedUnblockValue - left.expectedUnblockValue
    }
    return left.repairCode.localeCompare(right.repairCode)
  })
}

const buildWarrant = (input: {
  candidate: RepairCandidate
  exchangeInput: RepairWarrantExchangeInput
  scheduleDebtWindow: RepairWarrantScheduleDebtWindow
  admissionState: RepairWarrantRecord['admission_state']
  extraReasonCodes?: string[]
}): RepairWarrantRecord => {
  const sourceEpochId = input.exchangeInput.sourceRolloutTruthExchange.exchange_id
  const reasonCodes = uniqueStrings([...(input.extraReasonCodes ?? []), ...input.candidate.reasonCodes])
  const freshUntil = minIsoTimestamp(
    [
      input.exchangeInput.sourceRolloutTruthExchange.fresh_until,
      input.exchangeInput.sourceRolloutTruthExchange.torghut_proof_floor.fresh_until,
      input.scheduleDebtWindow.expires_at,
    ],
    addMs(input.exchangeInput.now, DEFAULT_FRESHNESS_MS).toISOString(),
  )
  const actionClass: ActionSloBudgetActionClass = 'dispatch_repair'
  const maxDispatches = input.admissionState === 'admitted' ? 1 : 0
  const maxRuntimeSeconds = input.admissionState === 'admitted' ? 20 * 60 : 0
  const warrantSource = {
    producer_revision: PRODUCER_REVISION,
    source_epoch_id: sourceEpochId,
    repair_code: input.candidate.repairCode,
    account_label: input.candidate.accountLabel,
    torghut_revision:
      input.exchangeInput.sourceRolloutTruthExchange.gitops_revision ??
      input.exchangeInput.sourceRolloutTruthExchange.source_head_sha,
    admission_state: input.admissionState,
    reason_codes: reasonCodes,
  }

  return {
    warrant_id: `repair-warrant:${input.candidate.repairCode}:${hashJson(warrantSource)}`,
    source_epoch_id: sourceEpochId,
    source_budget_id: input.candidate.sourceBudgetId,
    repair_code: input.candidate.repairCode,
    repair_dimension: input.candidate.repairDimension,
    account_label: input.candidate.accountLabel,
    torghut_revision:
      input.exchangeInput.sourceRolloutTruthExchange.gitops_revision ??
      input.exchangeInput.sourceRolloutTruthExchange.source_head_sha,
    action_class: actionClass,
    admission_state: input.admissionState,
    max_dispatches: maxDispatches,
    max_runtime_seconds: maxRuntimeSeconds,
    max_notional: 0,
    expected_unblock_value: input.candidate.expectedUnblockValue,
    risk_tier: input.candidate.riskTier,
    fresh_until: freshUntil,
    owner_lane: 'jangar-control-plane:repair',
    validation_refs: validationRefsForDimension(input.candidate.repairDimension),
    closure_requirements: closureRequirementsForDimension(input.candidate.repairDimension),
    rollback_target: 'disable warrant enforcement and fall back to dependency quorum plus action SLO budgets',
    reason_codes: reasonCodes,
    evidence_refs: uniqueStrings([
      REPAIR_WARRANT_EXCHANGE_DESIGN_ARTIFACT,
      sourceEpochId,
      input.exchangeInput.sourceRolloutTruthExchange.torghut_proof_floor.proof_floor_ref,
      ...input.candidate.evidenceRefs,
    ]),
  }
}

const suppressedCandidate = (
  candidate: RepairCandidate,
  admissionState: RepairWarrantSuppressedCandidate['admission_state'],
  reasonCodes: string[],
): RepairWarrantSuppressedCandidate => ({
  repair_code: candidate.repairCode,
  repair_dimension: candidate.repairDimension,
  account_label: candidate.accountLabel,
  admission_state: admissionState,
  reason_codes: uniqueStrings([...reasonCodes, ...candidate.reasonCodes]),
  evidence_refs: candidate.evidenceRefs,
})

export const buildRepairWarrantExchange = (input: RepairWarrantExchangeInput): RepairWarrantExchange => {
  const scheduleDebtWindow = buildScheduleDebtWindow({
    now: input.now,
    attempts: input.scheduleAttempts ?? [],
    collectionErrors: input.scheduleCollectionErrors ?? [],
  })
  const candidates = buildRepairCandidates(input)
  const rollbackTarget = 'set repair warrant enforcement to observe and keep dependency quorum/action SLO budgets'
  const maxActive = input.rolloutHealth.status === 'healthy' ? Number.POSITIVE_INFINITY : 1
  const collectionFailed = scheduleDebtWindow.collection_errors.length > 0
  const firebreakActive = scheduleDebtWindow.firebreak_state === 'observe_only'
  const watchDegraded = input.watchReliability.status === 'degraded'

  const activeWarrants: RepairWarrantRecord[] = []
  const expiredWarrants: RepairWarrantRecord[] = []
  const suppressedCandidates: RepairWarrantSuppressedCandidate[] = []

  for (const candidate of candidates) {
    if (watchDegraded) {
      expiredWarrants.push(
        buildWarrant({
          candidate,
          exchangeInput: input,
          scheduleDebtWindow,
          admissionState: 'expired',
          extraReasonCodes: ['watch_reliability_degraded'],
        }),
      )
      continue
    }

    if (firebreakActive) {
      activeWarrants.push(
        buildWarrant({
          candidate,
          exchangeInput: input,
          scheduleDebtWindow,
          admissionState: 'observe_only',
          extraReasonCodes: uniqueStrings([
            'schedule_debt_firebreak_observe_only',
            ...(collectionFailed ? ['schedule_debt_collection_error'] : []),
          ]),
        }),
      )
      continue
    }

    if (activeWarrants.length >= maxActive) {
      suppressedCandidates.push(
        suppressedCandidate(candidate, 'suppressed', ['rollout_readiness_degraded_one_warrant_limit']),
      )
      continue
    }

    activeWarrants.push(
      buildWarrant({
        candidate,
        exchangeInput: input,
        scheduleDebtWindow,
        admissionState: 'admitted',
      }),
    )
  }

  const status =
    watchDegraded || scheduleDebtWindow.collection_errors.length > 0
      ? 'degraded'
      : firebreakActive
        ? 'observe_only'
        : 'healthy'
  const exchangeId = `repair-warrant-exchange:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    source_epoch_id: input.sourceRolloutTruthExchange.exchange_id,
    active_warrant_ids: activeWarrants.map((warrant) => warrant.warrant_id).sort(),
    expired_warrant_ids: expiredWarrants.map((warrant) => warrant.warrant_id).sort(),
    schedule_debt: {
      firebreak_state: scheduleDebtWindow.firebreak_state,
      open_error_count: scheduleDebtWindow.open_error_count,
      superseded_error_count: scheduleDebtWindow.superseded_error_count,
    },
  })}`
  const freshUntil = minIsoTimestamp(
    [
      input.sourceRolloutTruthExchange.fresh_until,
      scheduleDebtWindow.expires_at,
      ...activeWarrants.map((warrant) => warrant.fresh_until),
      ...expiredWarrants.map((warrant) => warrant.fresh_until),
    ],
    addMs(input.now, DEFAULT_FRESHNESS_MS).toISOString(),
  )

  return {
    mode: 'observe',
    design_artifact: REPAIR_WARRANT_EXCHANGE_DESIGN_ARTIFACT,
    exchange_id: exchangeId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    status,
    source_epoch_id: input.sourceRolloutTruthExchange.exchange_id,
    schedule_debt_window: scheduleDebtWindow,
    active_warrants: activeWarrants,
    closed_warrants: [],
    expired_warrants: expiredWarrants,
    suppressed_candidates: suppressedCandidates,
    rollback_target: rollbackTarget,
  }
}
