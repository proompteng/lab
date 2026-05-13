import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  ReadyTruthArbiter,
  ReadyTruthMaterialReadiness,
  RolloutProofPassport,
  RolloutProofPassportStatus,
  RunnerCapacityFuture,
  RunnerCapacityFutureStatus,
  SourceRolloutTruthExchange,
  SourceServingContractVerdictExchange,
  StageClearanceStage,
  StageCreditLedger,
  StageLaunchTicket,
  StageLaunchTicketDecision,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type { FailureDomainKubernetesEvidence } from '~/server/control-plane-failure-domain-leases'
import type { ControlPlaneRolloutHealth, RuntimeAdapterStatus } from '~/server/control-plane-status-types'
import type { KubeGatewayEvent } from '~/server/kube-gateway'

export const ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT =
  'docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.rollout-proof-passport.v1' as const
const RUNNER_FUTURE_SCHEMA_VERSION = 'jangar.runner-capacity-future.v1' as const
const STAGE_LAUNCH_TICKET_SCHEMA_VERSION = 'jangar.stage-launch-ticket.v1' as const
const TTL_SECONDS = 60
const RUNNER_CAPACITY_WINDOW_MS = 15 * 60 * 1000
const MATERIAL_ACTIONS: ActionSloBudgetActionClass[] = ['dispatch_normal', 'deploy_widen', 'merge_ready']
const STAGE_ACTIONS: Array<{ stage: StageClearanceStage; actionClass: ActionSloBudgetActionClass }> = [
  { stage: 'discover', actionClass: 'dispatch_normal' },
  { stage: 'plan', actionClass: 'dispatch_normal' },
  { stage: 'implement', actionClass: 'dispatch_normal' },
  { stage: 'verify', actionClass: 'dispatch_normal' },
]
const VALUE_GATES = ['failed_agentrun_rate', 'pr_to_rollout_latency', 'ready_status_truth', 'manual_intervention_count']
const ROLLBACK_TARGET = 'JANGAR_ROLLOUT_PROOF_PASSPORT_MODE=observe'

type RolloutProofPassportInput = {
  now: Date
  namespace: string
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  controllerWitness: ControlPlaneControllerWitnessQuorum
  readyTruthArbiter: ReadyTruthArbiter
}

type RunnerCapacityFutureInput = {
  now: Date
  namespace: string
  rolloutProofPassport: RolloutProofPassport
  workflows: WorkflowsReliabilityStatus
  runtimeAdapters: RuntimeAdapterStatus[]
  kubernetesEvidence: FailureDomainKubernetesEvidence
  stageCreditLedger: StageCreditLedger | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeNonEmpty = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const firstDigest = (values: Array<string | null | undefined>) =>
  uniqueStrings(values.map((value) => normalizeNonEmpty(value)?.toLowerCase())).at(0) ?? null

const commitsMatch = (left: string | null, right: string | null) => {
  const a = normalizeNonEmpty(left)?.toLowerCase()
  const b = normalizeNonEmpty(right)?.toLowerCase()
  if (!a || !b || a === 'unknown' || b === 'unknown') return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

const timestampMs = (value: string | null | undefined) => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : null
}

const isStale = (now: Date, value: string | null | undefined) => {
  const parsed = timestampMs(value)
  return parsed === null || parsed <= now.getTime()
}

const statusEvidenceRef = (kind: string, state: string | null | undefined) => `${kind}:${state ?? 'unknown'}`

const workflowTimeoutReasons = (workflows: WorkflowsReliabilityStatus) =>
  workflows.top_failure_reasons
    .map((entry) => normalizeReason(entry.reason))
    .filter((reason) => reason.includes('timeout') || reason.includes('workflowsteptimedout'))

const eventTimestampMs = (event: KubeGatewayEvent) =>
  timestampMs(event.eventTime) ?? timestampMs(event.lastTimestamp) ?? timestampMs(event.firstTimestamp)

const eventEvidenceRef = (event: KubeGatewayEvent) =>
  `event:${event.metadata.namespace ?? event.involvedObject.namespace ?? 'unknown'}:${event.metadata.name}`

const eventText = (event: KubeGatewayEvent) =>
  normalizeReason(
    [event.reason, event.message, event.involvedObject.kind, event.involvedObject.name, event.metadata.name]
      .filter(Boolean)
      .join(' '),
  )

const eventMatchesStage = (event: KubeGatewayEvent, stage: StageClearanceStage) => {
  if (stage === 'serve' || stage === 'repair' || stage === 'deployer' || stage === 'torghut') return false
  const raw = [
    event.reason,
    event.message,
    event.involvedObject.name,
    event.metadata.name,
    event.metadata.labels?.['swarm.proompteng.ai/stage'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return raw.includes(stage)
}

const recentStageEvents = (input: RunnerCapacityFutureInput, stage: StageClearanceStage) =>
  input.kubernetesEvidence.events.filter((event) => {
    const observedMs = eventTimestampMs(event)
    if (observedMs === null || observedMs < input.now.getTime() - RUNNER_CAPACITY_WINDOW_MS) return false
    return eventMatchesStage(event, stage)
  })

const schedulingReasonCodes = (events: KubeGatewayEvent[]) => {
  const reasons: string[] = []
  for (const event of events) {
    const text = eventText(event)
    if (text.includes('failedscheduling') || text.includes('failed_scheduling')) {
      reasons.push('runner_capacity_failed_scheduling')
    }
    if (text.includes('affinity')) {
      reasons.push('runner_capacity_node_affinity_mismatch')
    }
    if (text.includes('taint') || text.includes('untolerated')) {
      reasons.push('runner_capacity_untolerated_taint')
    }
    if (text.includes('failedmount') || text.includes('mountvolume') || text.includes('configmap')) {
      reasons.push('runner_capacity_mount_failure')
    }
    if (text.includes('imagepull') || text.includes('image_pull') || text.includes('failed_to_pull')) {
      reasons.push('runner_capacity_image_pull_failure')
    }
  }
  return uniqueStrings(reasons)
}

const stageCreditAccount = (
  stageCreditLedger: StageCreditLedger | null,
  stage: StageClearanceStage,
  actionClass: ActionSloBudgetActionClass,
) =>
  stageCreditLedger?.stage_accounts.find(
    (account) => account.stage === stage && account.action_class === actionClass,
  ) ?? null

const materialDecisionFromPassport = (status: RolloutProofPassportStatus): ReadyTruthMaterialReadiness => {
  if (status === 'current') return 'allow'
  if (status === 'contradicted' || status === 'stale') return 'block'
  return 'hold'
}

export const buildRolloutProofPassport = (input: RolloutProofPassportInput): RolloutProofPassport => {
  const source = input.sourceRolloutTruthExchange
  const sourceServing = input.sourceServingContractVerdictExchange
  const sourceServingReasonCodes = uniqueStrings([
    ...sourceServing.reason_codes,
    ...sourceServing.verdicts.flatMap((verdict) => verdict.blocking_reason_codes),
  ]).map(normalizeReason)
  const sourceServingReported = (reasonCode: string) => sourceServingReasonCodes.includes(reasonCode)
  const sourceSha = normalizeNonEmpty(sourceServing.source_sha) ?? normalizeNonEmpty(source.source_head_sha)
  const manifestSha = normalizeNonEmpty(source.gitops_revision)
  const sourceCiRunId = sourceServingReported('source_ci_retention_receipt_missing')
    ? null
    : (sourceServing.verdicts.map((verdict) => normalizeNonEmpty(verdict.source_ci_run_id)).find(Boolean) ?? null)
  const sourceCiConclusion = sourceServingReported('source_ci_retention_receipt_missing')
    ? null
    : (sourceServing.verdicts.map((verdict) => normalizeNonEmpty(verdict.source_ci_conclusion)).find(Boolean) ?? null)
  const manifestImageDigest = sourceServingReported('manifest_image_digest_missing')
    ? null
    : firstDigest([
        sourceServing.manifest_image_digest,
        ...sourceServing.verdicts.map((verdict) => verdict.manifest_image_digest),
      ])
  const registryImageDigest = firstDigest(source.desired_images.map((image) => image.image_digest))
  const servingImageDigest = sourceServingReported('serving_image_digest_missing')
    ? null
    : firstDigest([
        sourceServing.serving_image_digest,
        ...sourceServing.verdicts.map((verdict) => verdict.serving_image_digest),
        ...source.live_images.map((image) => image.image_digest),
      ])
  const servingVerdict = sourceServing.verdicts.find((verdict) => verdict.action_class === 'serve_readonly')
  const materialVerdicts = sourceServing.verdicts.filter((verdict) =>
    MATERIAL_ACTIONS.includes(verdict.action_class as ActionSloBudgetActionClass),
  )
  const staleReasons = uniqueStrings([
    isStale(input.now, source.fresh_until) ? 'source_rollout_truth_stale' : null,
    isStale(input.now, sourceServing.fresh_until) ? 'source_serving_contract_stale' : null,
    isStale(input.now, input.readyTruthArbiter.fresh_until) ? 'ready_truth_arbiter_stale' : null,
  ])
  const collectingReasons = uniqueStrings([
    sourceSha ? null : 'source_sha_missing',
    manifestSha ? null : 'manifest_sha_missing',
    sourceCiRunId ? null : 'source_ci_retention_receipt_missing',
    manifestImageDigest ? null : 'manifest_image_digest_missing',
    registryImageDigest ? null : 'registry_image_digest_missing',
    servingImageDigest ? null : 'serving_image_digest_missing',
  ])
  const contradictionReasons = uniqueStrings([
    sourceSha && manifestSha && !commitsMatch(sourceSha, manifestSha) ? 'source_head_gitops_revision_mismatch' : null,
    manifestImageDigest && servingImageDigest && manifestImageDigest !== servingImageDigest
      ? 'manifest_serving_image_digest_mismatch'
      : null,
    registryImageDigest && manifestImageDigest && registryImageDigest !== manifestImageDigest
      ? 'registry_manifest_image_digest_mismatch'
      : null,
  ])
  const degradedReasons = uniqueStrings([
    input.rolloutHealth.status === 'healthy' ? null : `rollout_health_${input.rolloutHealth.status}`,
    input.database.status === 'healthy' ? null : `database_${input.database.status}`,
    input.database.migration_consistency.status === 'healthy'
      ? null
      : `database_migrations_${input.database.migration_consistency.status}`,
    input.controllerWitness.decision === 'allow' || input.controllerWitness.decision === 'allow_with_split'
      ? null
      : `controller_witness_${input.controllerWitness.decision}`,
    sourceServing.status === 'allow' || sourceServing.status === 'repair_only'
      ? null
      : `source_serving_contract_${sourceServing.status}`,
    input.readyTruthArbiter.material_readiness === 'allow'
      ? null
      : `ready_truth_material_${input.readyTruthArbiter.material_readiness}`,
  ])

  let status: RolloutProofPassportStatus = 'current'
  if (staleReasons.length > 0) {
    status = 'stale'
  } else if (contradictionReasons.length > 0) {
    status = 'contradicted'
  } else if (collectingReasons.length > 0) {
    status = 'collecting'
  } else if (degradedReasons.length > 0 || sourceServing.status === 'hold' || sourceServing.status === 'block') {
    status = 'degraded'
  }

  const reasonCodes = uniqueStrings([
    ...staleReasons,
    ...contradictionReasons,
    ...collectingReasons,
    ...degradedReasons,
    ...materialVerdicts.flatMap((verdict) => verdict.blocking_reason_codes),
  ])
  const materialActionDecision = materialDecisionFromPassport(status)
  const evidenceRefs = uniqueStrings([
    source.exchange_id,
    sourceServing.exchange_id,
    input.readyTruthArbiter.verdict_id,
    input.controllerWitness.quorum_id,
    statusEvidenceRef('database', input.database.status),
    statusEvidenceRef('rollout', input.rolloutHealth.status),
    servingVerdict?.verdict_id,
    ...materialVerdicts.map((verdict) => verdict.verdict_id),
  ])
  const passportId = `rollout-proof-passport:${hashJson({
    sourceSha,
    manifestSha,
    manifestImageDigest,
    registryImageDigest,
    servingImageDigest,
    status,
    materialActionDecision,
    reasonCodes,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    passport_id: passportId,
    generated_at: input.now.toISOString(),
    fresh_until: addSeconds(input.now, TTL_SECONDS).toISOString(),
    namespace: input.namespace,
    governing_design_refs: [
      ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT,
      'swarm-validation-contract:green-pr-to-healthy-rollout',
    ],
    source_head_sha: sourceSha,
    source_ci_run_id: sourceCiRunId,
    source_ci_conclusion: sourceCiConclusion,
    manifest_sha: manifestSha,
    manifest_image_digest: manifestImageDigest,
    registry_image_digest: registryImageDigest,
    argo_sync_revision: manifestSha,
    argo_health: input.rolloutHealth.status,
    workload_ready:
      input.rolloutHealth.status === 'healthy' &&
      input.rolloutHealth.deployments.every(
        (deployment) => deployment.available_replicas >= deployment.desired_replicas,
      ),
    serving_revision: servingVerdict?.serving_revision ?? null,
    serving_build_commit: sourceServing.serving_build_commit,
    serving_image_digest: servingImageDigest,
    database_projection_ref: source.database_projection_ref,
    database_status: input.database.status,
    controller_witness_ref: input.controllerWitness.quorum_id,
    controller_witness_decision: input.controllerWitness.decision,
    ready_truth_ref: input.readyTruthArbiter.verdict_id,
    serving_readiness: input.readyTruthArbiter.serving_readiness,
    material_launch_decision: input.readyTruthArbiter.material_readiness,
    status,
    material_action_decision: materialActionDecision,
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    value_gates: ['pr_to_rollout_latency', 'ready_status_truth', 'handoff_evidence_quality'],
    rollback_target: ROLLBACK_TARGET,
  }
}

const buildRunnerCapacityFuture = (
  input: RunnerCapacityFutureInput,
  stage: StageClearanceStage,
  actionClass: ActionSloBudgetActionClass,
): RunnerCapacityFuture => {
  const account = stageCreditAccount(input.stageCreditLedger, stage, actionClass)
  const events = recentStageEvents(input, stage)
  const eventReasonCodes = schedulingReasonCodes(events)
  const timeoutReasons = workflowTimeoutReasons(input.workflows)
  const runtimeUnavailable = input.runtimeAdapters
    .filter((adapter) => adapter.name === 'workflow' || adapter.name === 'job')
    .filter((adapter) => !adapter.available || (adapter.status !== 'healthy' && adapter.status !== 'configured'))
  const reasonCodes = uniqueStrings([
    ...eventReasonCodes,
    ...timeoutReasons.map((reason) => `runner_capacity_${reason}`),
    ...(account && account.decision !== 'allow' ? [`stage_credit_${account.decision}`] : []),
    ...(input.rolloutProofPassport.manifest_image_digest ? [] : ['runner_capacity_image_digest_missing']),
    ...runtimeUnavailable.map((adapter) => `runtime_adapter_${normalizeReason(adapter.name)}_${adapter.status}`),
  ])

  let capacityState: RunnerCapacityFutureStatus = 'available'
  if (runtimeUnavailable.length > 0 || account?.decision === 'block') {
    capacityState = 'unavailable'
  } else if (
    reasonCodes.length > 0 ||
    account?.decision === 'hold' ||
    input.rolloutProofPassport.status === 'collecting' ||
    input.rolloutProofPassport.status === 'degraded'
  ) {
    capacityState = 'constrained'
  }
  if (!account && input.stageCreditLedger) {
    capacityState = capacityState === 'unavailable' ? 'unavailable' : 'constrained'
    reasonCodes.push('stage_credit_account_missing')
  }
  if (input.workflows.data_confidence === 'unknown') {
    capacityState = capacityState === 'available' ? 'unknown' : capacityState
    reasonCodes.push('workflow_reliability_unknown')
  }

  const normalizedReasonCodes = uniqueStrings(reasonCodes)
  const evidenceRefs = uniqueStrings([
    input.rolloutProofPassport.passport_id,
    input.stageCreditLedger?.ledger_id,
    account?.account_id,
    ...events.map(eventEvidenceRef),
    ...runtimeUnavailable.map((adapter) => `runtime-adapter:${adapter.name}:${adapter.status}`),
    ...(timeoutReasons.length > 0 ? ['workflows:top_failure_reasons'] : []),
  ])
  const futureId = `runner-capacity-future:${stage}:${actionClass}:${hashJson({
    stage,
    actionClass,
    capacityState,
    reasonCodes: normalizedReasonCodes,
    account: account?.account_id ?? null,
  })}`

  return {
    schema_version: RUNNER_FUTURE_SCHEMA_VERSION,
    future_id: futureId,
    generated_at: input.now.toISOString(),
    expires_at: addSeconds(input.now, TTL_SECONDS).toISOString(),
    namespace: input.namespace,
    governing_design_refs: [ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT],
    stage,
    action_class: actionClass,
    launch_window: '15m',
    capacity_state: capacityState,
    max_parallelism: Math.max(0, account?.max_concurrent_runs ?? (capacityState === 'available' ? 1 : 0)),
    max_runtime_seconds: account?.max_runtime_seconds ?? null,
    recent_failure_reasons: eventReasonCodes,
    reason_codes: normalizedReasonCodes,
    evidence_refs: evidenceRefs,
    value_gates: ['failed_agentrun_rate', 'manual_intervention_count'],
    rollback_target: ROLLBACK_TARGET,
  }
}

export const buildRunnerCapacityFutures = (input: RunnerCapacityFutureInput): RunnerCapacityFuture[] =>
  STAGE_ACTIONS.map(({ stage, actionClass }) => buildRunnerCapacityFuture(input, stage, actionClass))

const launchDecision = (passport: RolloutProofPassport, future: RunnerCapacityFuture): StageLaunchTicketDecision => {
  if (passport.material_action_decision === 'block' || future.capacity_state === 'unavailable') return 'block'
  if (passport.material_action_decision !== 'allow' || future.capacity_state !== 'available') return 'hold'
  return 'allow'
}

export const buildStageLaunchTickets = ({
  now,
  namespace,
  rolloutProofPassport,
  runnerCapacityFutures,
}: {
  now: Date
  namespace: string
  rolloutProofPassport: RolloutProofPassport
  runnerCapacityFutures: RunnerCapacityFuture[]
}): StageLaunchTicket[] =>
  runnerCapacityFutures.map((future) => {
    const decision = launchDecision(rolloutProofPassport, future)
    const reasonCodes = uniqueStrings([
      ...rolloutProofPassport.reason_codes.map((reason) => `rollout_proof:${reason}`),
      ...future.reason_codes.map((reason) => `runner_capacity:${reason}`),
    ])
    return {
      schema_version: STAGE_LAUNCH_TICKET_SCHEMA_VERSION,
      ticket_id: `stage-launch-ticket:${future.stage}:${future.action_class}:${hashJson({
        passport: rolloutProofPassport.passport_id,
        future: future.future_id,
        decision,
      })}`,
      generated_at: now.toISOString(),
      fresh_until: addSeconds(now, TTL_SECONDS).toISOString(),
      namespace,
      governing_design_refs: [ROLLOUT_PROOF_PASSPORT_DESIGN_ARTIFACT],
      stage: future.stage,
      action_class: future.action_class,
      rollout_proof_passport_ref: rolloutProofPassport.passport_id,
      runner_capacity_future_ref: future.future_id,
      decision,
      reason_codes: reasonCodes,
      evidence_refs: uniqueStrings([rolloutProofPassport.passport_id, future.future_id]),
      value_gates: VALUE_GATES,
      rollback_target: ROLLBACK_TARGET,
    }
  })
