import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  SourceRolloutTruthExchange,
  SourceServingContractActionClass,
  SourceServingContractDecision,
  SourceServingContractState,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
} from '~/data/agents-control-plane'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT =
  'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md'

const PRODUCER_REVISION = '2026-05-13-source-serving-contract-verdict-observe-v1'
const VERDICT_SCHEMA_VERSION = 'jangar.source-serving-contract-verdict.v1' as const
const DEFAULT_REPOSITORY = 'proompteng/lab'
const DEFAULT_REQUIRED_CONTRACTS = ['route_warrant_exchange', 'repair_bid_settlement_ledger']

const ACTION_CLASSES: SourceServingContractActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'paper_support',
  'live_support',
]

const DECISION_RANK: Record<SourceServingContractDecision, number> = {
  allow: 0,
  repair_only: 1,
  hold: 2,
  block: 3,
}

export type SourceServingContractEvidence = {
  sourceCiRunId?: string | null
  sourceCiConclusion?: string | null
  manifestImageDigest?: string | null
  requiredContracts?: string[]
}

export type SourceServingContractVerdictInput = {
  now: Date
  namespace: string
  repository?: string
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  rolloutHealth: ControlPlaneRolloutHealth
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  evidence?: SourceServingContractEvidence
}

type SourceServingSummary = {
  sourceSha: string | null
  manifestSha: string | null
  manifestImageDigest: string | null
  servingRevision: string | null
  servingBuildCommit: string | null
  servingImageDigest: string | null
  requiredContracts: string[]
  observedContracts: string[]
  missingContracts: string[]
  contractSchemaMismatches: string[]
  routeWarrantRef: string | null
  repairBidSettlementRef: string | null
  maxNotional: number
  sourceCiRunId: string | null
  sourceCiConclusion: string | null
  sourceCiPassed: boolean
  sourceRevisionMissing: boolean
  sourceGitopsMismatch: boolean
  servingBuildMissing: boolean
  sourceServingMismatch: boolean
  manifestDigestMissing: boolean
  servingDigestMissing: boolean
  manifestServingDigestMismatch: boolean
  argoHealthy: boolean
  state: SourceServingContractState
  reasonCodes: string[]
}

type EnvSource = Record<string, string | undefined>

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const normalizeNonEmpty = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  return normalized.length > 0 ? normalized : null
}

const compactStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const parseContractList = (value: string | null | undefined) =>
  compactStrings(
    (value ?? '')
      .split(',')
      .map((entry) =>
        entry
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_.:-]+/g, '_'),
      )
      .filter(Boolean),
  )

export const resolveSourceServingContractEnvironment = (
  env: EnvSource = process.env,
): SourceServingContractEvidence => ({
  sourceCiRunId: normalizeNonEmpty(env.JANGAR_SOURCE_CI_RUN_ID ?? env.SOURCE_CI_RUN_ID),
  sourceCiConclusion: normalizeNonEmpty(env.JANGAR_SOURCE_CI_CONCLUSION ?? env.SOURCE_CI_CONCLUSION),
  manifestImageDigest: normalizeNonEmpty(env.JANGAR_MANIFEST_IMAGE_DIGEST ?? env.MANIFEST_IMAGE_DIGEST),
  requiredContracts: parseContractList(
    env.JANGAR_SOURCE_SERVING_REQUIRED_CONTRACTS ?? env.SOURCE_SERVING_REQUIRED_CONTRACTS,
  ),
})

const commitsMatch = (left: string | null, right: string | null) => {
  const a = normalizeNonEmpty(left)?.toLowerCase()
  const b = normalizeNonEmpty(right)?.toLowerCase()
  if (!a || !b || a === 'unknown' || b === 'unknown') return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

const digestKey = (value: string | null | undefined) => normalizeNonEmpty(value)?.toLowerCase() ?? ''

const numberValue = (value: string | number | null | undefined) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right)
  return timestamps.length > 0 ? new Date(timestamps[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const routeWarrantRef = (status: TorghutConsumerEvidenceStatus) =>
  status.route_warrant_id ?? (status.route_warrant_state ? `torghut-route-warrant:${status.route_warrant_state}` : null)

const sourceCiPassed = (conclusion: string | null) =>
  Boolean(conclusion && ['success', 'succeeded', 'passed', 'pass'].includes(conclusion.toLowerCase()))

const resolveSourceServingSummary = (input: SourceServingContractVerdictInput): SourceServingSummary => {
  const source = input.sourceRolloutTruthExchange
  const torghut = input.torghutConsumerEvidence
  const evidence = input.evidence ?? resolveSourceServingContractEnvironment()
  const sourceSha = normalizeNonEmpty(source.source_head_sha)
  const manifestSha = normalizeNonEmpty(source.gitops_revision)
  const sourceCiRunId = normalizeNonEmpty(evidence.sourceCiRunId)
  const sourceCiConclusion = normalizeNonEmpty(evidence.sourceCiConclusion)
  const requiredContracts =
    evidence.requiredContracts && evidence.requiredContracts.length > 0
      ? evidence.requiredContracts
      : DEFAULT_REQUIRED_CONTRACTS
  const observedContracts = compactStrings(torghut.observed_contracts ?? [])
  const missingContracts = requiredContracts.filter((contract) => !observedContracts.includes(contract))
  const contractSchemaMismatches = compactStrings(torghut.contract_schema_mismatches ?? [])
  const manifestImageDigest = normalizeNonEmpty(evidence.manifestImageDigest)
  const servingImageDigest = normalizeNonEmpty(torghut.serving_image_digest) ?? normalizeNonEmpty(torghut.image_digest)
  const servingBuildCommit = normalizeNonEmpty(torghut.build_commit)
  const sourceRevisionMissing = !sourceSha || !manifestSha
  const sourceGitopsMismatch = Boolean(sourceSha && manifestSha && !commitsMatch(sourceSha, manifestSha))
  const servingBuildMissing = !servingBuildCommit || servingBuildCommit === 'unknown'
  const sourceServingMismatch = Boolean(sourceSha && servingBuildCommit && !commitsMatch(sourceSha, servingBuildCommit))
  const manifestDigestMissing = !manifestImageDigest
  const servingDigestMissing = !servingImageDigest
  const manifestServingDigestMismatch = Boolean(
    manifestImageDigest && servingImageDigest && digestKey(manifestImageDigest) !== digestKey(servingImageDigest),
  )
  const argoHealthy = input.rolloutHealth.status === 'healthy'
  const routeRef = routeWarrantRef(torghut)
  const repairBidRef = normalizeNonEmpty(torghut.repair_bid_settlement_ledger_id)
  const ciPassed = sourceCiPassed(sourceCiConclusion)
  const state: SourceServingContractState =
    missingContracts.length > 0 || contractSchemaMismatches.length > 0
      ? 'contract_missing'
      : sourceRevisionMissing || servingBuildMissing
        ? 'unknown'
        : sourceServingMismatch || sourceGitopsMismatch || manifestServingDigestMismatch
          ? 'source_ahead'
          : manifestDigestMissing || servingDigestMissing
            ? 'digest_unknown'
            : 'converged'
  const reasonCodes = compactStrings([
    ...(sourceCiRunId ? [] : ['source_ci_retention_receipt_missing']),
    ...(sourceCiRunId && !ciPassed ? [`source_ci_not_success:${sourceCiConclusion ?? 'unknown'}`] : []),
    ...(sourceSha ? [] : ['source_sha_missing']),
    ...(manifestSha ? [] : ['manifest_sha_missing']),
    ...(sourceGitopsMismatch ? ['source_head_gitops_revision_mismatch'] : []),
    ...(servingBuildMissing ? ['serving_build_commit_missing'] : []),
    ...(sourceServingMismatch ? ['source_serving_build_mismatch'] : []),
    ...(manifestDigestMissing ? ['manifest_image_digest_missing'] : []),
    ...(servingDigestMissing ? ['serving_image_digest_missing'] : []),
    ...(manifestServingDigestMismatch ? ['manifest_serving_image_digest_mismatch'] : []),
    ...(argoHealthy ? [] : [`argo_health_${input.rolloutHealth.status}`]),
    ...missingContracts.map((contract) => `source_serving_contract_missing:${contract}`),
    ...contractSchemaMismatches.map((contract) => `source_serving_contract_schema_mismatch:${contract}`),
    ...(routeRef ? [] : ['torghut_route_warrant_missing']),
    ...(repairBidRef ? [] : ['repair_bid_settlement_ledger_missing']),
  ])

  return {
    sourceSha,
    manifestSha,
    manifestImageDigest,
    servingRevision: normalizeNonEmpty(torghut.serving_revision),
    servingBuildCommit,
    servingImageDigest,
    requiredContracts,
    observedContracts,
    missingContracts,
    contractSchemaMismatches,
    routeWarrantRef: routeRef,
    repairBidSettlementRef: repairBidRef,
    maxNotional: numberValue(torghut.max_notional),
    sourceCiRunId,
    sourceCiConclusion,
    sourceCiPassed: ciPassed,
    sourceRevisionMissing,
    sourceGitopsMismatch,
    servingBuildMissing,
    sourceServingMismatch,
    manifestDigestMissing,
    servingDigestMissing,
    manifestServingDigestMismatch,
    argoHealthy,
    state,
    reasonCodes,
  }
}

const fullProofConverged = (summary: SourceServingSummary) =>
  summary.state === 'converged' &&
  summary.sourceCiPassed &&
  summary.argoHealthy &&
  summary.routeWarrantRef &&
  summary.repairBidSettlementRef &&
  summary.reasonCodes.length === 0

const repairProofAvailable = (summary: SourceServingSummary) =>
  (summary.state === 'converged' || summary.state === 'digest_unknown') &&
  summary.sourceCiPassed &&
  summary.argoHealthy &&
  !summary.sourceRevisionMissing &&
  !summary.sourceGitopsMismatch &&
  !summary.servingBuildMissing &&
  !summary.sourceServingMismatch &&
  summary.missingContracts.length === 0 &&
  summary.contractSchemaMismatches.length === 0 &&
  Boolean(summary.routeWarrantRef) &&
  Boolean(summary.repairBidSettlementRef) &&
  summary.maxNotional === 0

const decisionForAction = (
  actionClass: SourceServingContractActionClass,
  summary: SourceServingSummary,
): SourceServingContractDecision => {
  if (actionClass === 'serve_readonly') return 'allow'
  if (actionClass === 'dispatch_repair') {
    if (repairProofAvailable(summary)) return 'repair_only'
    return fullProofConverged(summary) ? 'allow' : 'hold'
  }
  if (actionClass === 'live_support') {
    return fullProofConverged(summary) && summary.maxNotional > 0 ? 'allow' : 'block'
  }
  return fullProofConverged(summary) ? 'allow' : 'hold'
}

const maxNotionalForAction = (
  actionClass: SourceServingContractActionClass,
  decision: SourceServingContractDecision,
  summary: SourceServingSummary,
) => {
  if (decision === 'hold' || decision === 'block') return 0
  if (actionClass === 'paper_support' || actionClass === 'live_support') return summary.maxNotional
  return 0
}

const valueGateImpacts = (summary: SourceServingSummary) =>
  compactStrings([
    'ready_status_truth',
    ...(summary.sourceServingMismatch || summary.manifestServingDigestMismatch || summary.reasonCodes.length > 0
      ? ['pr_to_rollout_latency', 'handoff_evidence_quality']
      : []),
    ...(summary.missingContracts.length > 0 ? ['manual_intervention_count'] : []),
  ])

const requiredRepairReceipts = (summary: SourceServingSummary) =>
  compactStrings([
    ...(summary.sourceCiRunId ? [] : ['main-source-ci-retention-receipt']),
    ...(summary.sourceServingMismatch || summary.sourceGitopsMismatch
      ? ['source-serving-build-reconcile-receipt']
      : []),
    ...(summary.manifestDigestMissing || summary.servingDigestMissing || summary.manifestServingDigestMismatch
      ? ['source-serving-image-digest-reconcile-receipt']
      : []),
    ...summary.missingContracts.map((contract) => `source-serving-contract-canary:${contract}`),
    ...summary.contractSchemaMismatches.map((contract) => `source-serving-contract-schema-repair:${contract}`),
  ])

const blockingReasonsForAction = (
  actionClass: SourceServingContractActionClass,
  decision: SourceServingContractDecision,
  summary: SourceServingSummary,
) => {
  if (decision === 'allow') return []
  if (actionClass === 'dispatch_repair' && decision === 'repair_only') {
    return compactStrings([
      ...(summary.servingDigestMissing ? ['serving_image_digest_missing'] : []),
      ...(summary.manifestDigestMissing ? ['manifest_image_digest_missing'] : []),
    ])
  }
  return summary.reasonCodes
}

const buildVerdict = (input: {
  statusInput: SourceServingContractVerdictInput
  summary: SourceServingSummary
  actionClass: SourceServingContractActionClass
  freshUntil: string
}) => {
  const decision = decisionForAction(input.actionClass, input.summary)
  const blockingReasonCodes = blockingReasonsForAction(input.actionClass, decision, input.summary)
  const evidenceRefs = compactStrings([
    SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT,
    input.statusInput.sourceRolloutTruthExchange.exchange_id,
    input.statusInput.torghutConsumerEvidence.receipt_id,
    input.summary.routeWarrantRef,
    input.summary.repairBidSettlementRef,
    input.summary.sourceCiRunId ? `github-actions-run:${input.summary.sourceCiRunId}` : null,
    input.summary.manifestImageDigest ? `manifest-image:${input.summary.manifestImageDigest}` : null,
    input.summary.servingImageDigest ? `serving-image:${input.summary.servingImageDigest}` : null,
    `argo-health:${input.statusInput.rolloutHealth.status}`,
  ])
  const verdictId = `source-serving-verdict:${input.actionClass}:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.statusInput.namespace,
    action_class: input.actionClass,
    decision,
    source_sha: input.summary.sourceSha,
    serving_build_commit: input.summary.servingBuildCommit,
    manifest_image_digest: input.summary.manifestImageDigest,
    serving_image_digest: input.summary.servingImageDigest,
    missing_contracts: input.summary.missingContracts,
    blocking_reason_codes: blockingReasonCodes,
  })}`

  return {
    schema_version: VERDICT_SCHEMA_VERSION,
    verdict_id: verdictId,
    generated_at: input.statusInput.now.toISOString(),
    fresh_until: input.freshUntil,
    repository: input.statusInput.repository ?? DEFAULT_REPOSITORY,
    source_sha: input.summary.sourceSha,
    source_ci_run_id: input.summary.sourceCiRunId,
    source_ci_conclusion: input.summary.sourceCiConclusion,
    manifest_sha: input.summary.manifestSha,
    manifest_image_digest: input.summary.manifestImageDigest,
    argo_sync_revision: input.summary.manifestSha,
    argo_health: input.statusInput.rolloutHealth.status,
    serving_revision: input.summary.servingRevision,
    serving_build_commit: input.summary.servingBuildCommit,
    serving_image_digest: input.summary.servingImageDigest,
    required_contracts: input.summary.requiredContracts,
    observed_contracts: input.summary.observedContracts,
    missing_contracts: input.summary.missingContracts,
    contract_schema_mismatches: input.summary.contractSchemaMismatches,
    torghut_route_warrant_ref: input.summary.routeWarrantRef,
    torghut_repair_bid_settlement_ref: input.summary.repairBidSettlementRef,
    action_class: input.actionClass,
    decision,
    source_serving_state: input.summary.state,
    max_notional: maxNotionalForAction(input.actionClass, decision, input.summary),
    value_gate_impacts: valueGateImpacts(input.summary),
    required_repair_receipts: requiredRepairReceipts(input.summary),
    blocking_reason_codes: blockingReasonCodes,
    evidence_refs: evidenceRefs,
    rollback_gate:
      'keep source-serving verdicts in observe mode and continue using route warrants plus Torghut capital gates',
  } satisfies SourceServingContractVerdict
}

const stricterDecision = (left: SourceServingContractDecision, right: SourceServingContractDecision) =>
  DECISION_RANK[left] >= DECISION_RANK[right] ? left : right

export const buildSourceServingContractVerdictExchange = (
  input: SourceServingContractVerdictInput,
): SourceServingContractVerdictExchange => {
  const summary = resolveSourceServingSummary(input)
  const fallbackFreshUntil = new Date(input.now.getTime() + 60_000).toISOString()
  const freshUntil = minIsoTimestamp(
    [input.sourceRolloutTruthExchange.fresh_until, input.torghutConsumerEvidence.fresh_until, fallbackFreshUntil],
    fallbackFreshUntil,
  )
  const verdicts = ACTION_CLASSES.map((actionClass) =>
    buildVerdict({ statusInput: input, summary, actionClass, freshUntil }),
  )
  const verdictRefs = verdicts.map((verdict) => verdict.verdict_id)
  const status = verdicts.reduce<SourceServingContractDecision>(
    (decision, verdict) => stricterDecision(decision, verdict.decision),
    'allow',
  )
  const exchangeId = `source-serving-verdict-exchange:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    source_sha: summary.sourceSha,
    serving_build_commit: summary.servingBuildCommit,
    status,
    verdict_refs: verdictRefs,
  })}`

  return {
    mode: 'observe',
    design_artifact: SOURCE_SERVING_CONTRACT_VERDICT_DESIGN_ARTIFACT,
    exchange_id: exchangeId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    status,
    source_sha: summary.sourceSha,
    serving_build_commit: summary.servingBuildCommit,
    manifest_image_digest: summary.manifestImageDigest,
    serving_image_digest: summary.servingImageDigest,
    required_contracts: summary.requiredContracts,
    observed_contracts: summary.observedContracts,
    missing_contracts: summary.missingContracts,
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
      'ignore source_serving_contract_verdict_exchange consumers and keep Torghut paper/live held by existing capital gates',
  }
}
