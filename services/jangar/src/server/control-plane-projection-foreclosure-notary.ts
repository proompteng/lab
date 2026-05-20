import { createHash } from 'node:crypto'

import type {
  ProjectionForeclosureAuthorityState,
  ProjectionForeclosureClaim,
  ProjectionForeclosureClaimClass,
  ProjectionForeclosureClaimTotalsByState,
  ProjectionForeclosureDecision,
  ProjectionForeclosureNotary,
  ProjectionForeclosureReceipt,
  ProjectionForeclosureValueGate,
  ProjectionMissingReceipt,
  StageClearancePacket,
} from '~/server/control-plane-status-types'
import {
  ACTIVE_PROJECTION_STATUSES,
  type JsonRecord,
  type ProjectionForeclosureAgentRunProjection,
  type ProjectionForeclosureMarketContextProjection,
  type ProjectionForeclosureNotaryInput,
} from '~/server/control-plane-projection-foreclosure-evidence'

export {
  collectProjectionForeclosureEvidence,
  emptyProjectionForeclosureEvidence,
  isProjectionForeclosureConsumptionEnabled,
  isProjectionForeclosureNotaryEnabled,
  type ProjectionForeclosureAgentRunProjection,
  type ProjectionForeclosureEvidence,
  type ProjectionForeclosureMarketContextProjection,
  type ProjectionForeclosureNotaryInput,
} from '~/server/control-plane-projection-foreclosure-evidence'

export const PROJECTION_FORECLOSURE_NOTARY_DESIGN_ARTIFACT =
  'docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.projection-foreclosure-notary.v1' as const
const PRODUCER_REVISION = '2026-05-13-projection-foreclosure-notary-observe-v1'
const DEFAULT_ROLLBACK_TARGET = 'JANGAR_PROJECTION_FORECLOSURE_NOTARY_ENABLED=false'
const DEFAULT_TTL_SECONDS = 120
const DEFAULT_AUTHORITY_BUDGET_SECONDS = 6 * 60 * 60
const MARKET_CONTEXT_BUDGET_SECONDS: Record<string, number> = {
  fundamentals: 6 * 60 * 60,
  news: 2 * 60 * 60,
}

const GOVERNING_DESIGN_REFS = [
  PROJECTION_FORECLOSURE_NOTARY_DESIGN_ARTIFACT,
  'docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md',
  'docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

const AUTHORITY_STATES: ProjectionForeclosureAuthorityState[] = [
  'authoritative',
  'grace',
  'stale_foreclosed',
  'contradictory',
  'missing_receipt',
  'terminal_audit',
  'unknown',
]

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'success',
  'completed',
  'complete',
  'failed',
  'failure',
  'error',
  'errored',
  'cancelled',
  'canceled',
  'timed_out',
  'timeout',
])

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}

const parseDate = (value: string | null | undefined) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeStatus = (value: string | null | undefined) =>
  (value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const normalizeDomain = (value: string | null | undefined) =>
  (value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const uniqueValueGates = (values: ProjectionForeclosureValueGate[]) =>
  [...new Set(values)] as ProjectionForeclosureValueGate[]

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const readNestedNumber = (payload: JsonRecord, keys: string[]) => {
  for (const key of keys) {
    const value = payload[key]
    const direct = readNumber(value)
    if (direct !== null) return direct
  }

  const spec = asRecord(payload.spec)
  for (const key of keys) {
    const value = spec[key]
    const nested = readNumber(value)
    if (nested !== null) return nested
  }

  const parameters = asRecord(payload.parameters)
  for (const key of keys) {
    const value = parameters[key]
    const nested = readNumber(value)
    if (nested !== null) return nested
  }

  return null
}

const authorityBudgetSeconds = (payload: JsonRecord) => {
  const timeoutSeconds =
    readNestedNumber(payload, ['timeoutSeconds', 'timeout_seconds', 'maxRuntimeSeconds', 'max_runtime_seconds']) ??
    (readNestedNumber(payload, ['timeoutMs', 'timeout_ms']) ?? 0) / 1000
  const scheduleSeconds =
    readNestedNumber(payload, ['scheduleIntervalSeconds', 'schedule_interval_seconds', 'everySeconds']) ??
    (readNestedNumber(payload, ['scheduleIntervalMs', 'schedule_interval_ms', 'everyMs']) ?? 0) / 1000

  return Math.max(DEFAULT_AUTHORITY_BUDGET_SECONDS, timeoutSeconds, scheduleSeconds * 2)
}

const claimId = (claimClass: ProjectionForeclosureClaimClass, parts: unknown[]) =>
  `projection-claim:${claimClass}:${hashJson(parts, 14)}`

const receiptId = (claim: ProjectionForeclosureClaim) =>
  `projection-foreclosure-receipt:${hashJson(
    [claim.claim_id, claim.authority_state, claim.source_ref, claim.projection_ref],
    16,
  )}`

const buildClaim = (input: Omit<ProjectionForeclosureClaim, 'claim_id'>): ProjectionForeclosureClaim => ({
  claim_id: claimId(input.claim_class, [input.source_ref, input.projection_ref, input.authority_state]),
  ...input,
  reason_codes: uniqueStrings(input.reason_codes).map(normalizeStatus),
  value_gates: uniqueValueGates(input.value_gates),
})

const classifyAgentRunProjection = (
  input: ProjectionForeclosureNotaryInput,
  projection: ProjectionForeclosureAgentRunProjection,
): ProjectionForeclosureClaim => {
  const status = normalizeStatus(projection.status)
  const observedAt = projection.updated_at ?? projection.created_at
  const observedDate = parseDate(observedAt) ?? input.now
  const budgetSeconds = authorityBudgetSeconds(projection.payload)
  const freshUntil = addSeconds(observedDate, budgetSeconds)
  const projectionRef = `agent_runs:${projection.id}`
  const agentsAuthorityRef = projection.external_run_id
    ? `agents-service-agentrun:${projection.external_run_id}`
    : `agents-service-agent-run-record:${projection.id}`

  if (TERMINAL_STATUSES.has(status)) {
    return buildClaim({
      claim_class: 'agentrun_execution',
      source_ref: projectionRef,
      source_owner: projection.agent_name,
      lane: normalizeStatus(projection.agent_name),
      status,
      observed_at: observedAt,
      last_heartbeat_at: projection.updated_at,
      fresh_until: null,
      live_authority_ref: agentsAuthorityRef,
      projection_ref: projectionRef,
      authority_state: 'terminal_audit',
      reason_codes: ['agents_service_agentrun_projection_terminal_audit'],
      value_gates: ['failed_agentrun_rate', 'handoff_evidence_quality'],
    })
  }

  const authorityState: ProjectionForeclosureAuthorityState =
    ACTIVE_PROJECTION_STATUSES.has(status) && freshUntil.getTime() >= input.now.getTime()
      ? 'authoritative'
      : ACTIVE_PROJECTION_STATUSES.has(status)
        ? 'stale_foreclosed'
        : 'grace'

  return buildClaim({
    claim_class: 'agentrun_execution',
    source_ref: projectionRef,
    source_owner: projection.agent_name,
    lane: normalizeStatus(projection.agent_name),
    status,
    observed_at: observedAt,
    last_heartbeat_at: projection.updated_at,
    fresh_until: freshUntil.toISOString(),
    live_authority_ref: agentsAuthorityRef,
    projection_ref: projectionRef,
    authority_state: authorityState,
    reason_codes:
      authorityState === 'authoritative'
        ? ['agents_service_agentrun_projection_current']
        : authorityState === 'stale_foreclosed'
          ? ['agents_service_agentrun_projection_not_renewed']
          : ['agents_service_agentrun_projection_inside_grace_budget'],
    value_gates: ['failed_agentrun_rate', 'ready_status_truth', 'manual_intervention_count'],
  })
}

const marketContextClaimClass = (domain: string): ProjectionForeclosureClaimClass => {
  const normalized = normalizeDomain(domain)
  if (normalized === 'news') return 'market_context_news'
  return 'market_context_fundamentals'
}

const classifyMarketContextProjection = (
  input: ProjectionForeclosureNotaryInput,
  projection: ProjectionForeclosureMarketContextProjection,
): ProjectionForeclosureClaim => {
  const status = normalizeStatus(projection.status)
  const domain = normalizeDomain(projection.domain)
  const heartbeatAt =
    projection.last_heartbeat_at ?? projection.updated_at ?? projection.started_at ?? projection.created_at
  const heartbeatDate = parseDate(heartbeatAt) ?? input.now
  const budgetSeconds = MARKET_CONTEXT_BUDGET_SECONDS[domain] ?? DEFAULT_AUTHORITY_BUDGET_SECONDS
  const freshUntil = addSeconds(heartbeatDate, budgetSeconds)
  const projectionRef = `torghut_market_context_runs:${projection.request_id}`

  if (TERMINAL_STATUSES.has(status)) {
    return buildClaim({
      claim_class: marketContextClaimClass(domain),
      source_ref: projectionRef,
      source_owner: `market-context:${domain}`,
      lane: domain,
      status,
      observed_at: projection.updated_at ?? projection.finished_at ?? projection.created_at,
      last_heartbeat_at: heartbeatAt,
      fresh_until: null,
      live_authority_ref: null,
      projection_ref: projectionRef,
      authority_state: 'terminal_audit',
      reason_codes: [`market_context_${domain}_terminal_audit`],
      value_gates: ['handoff_evidence_quality', 'ready_status_truth'],
    })
  }

  const authorityState: ProjectionForeclosureAuthorityState =
    ACTIVE_PROJECTION_STATUSES.has(status) && freshUntil.getTime() < input.now.getTime() ? 'stale_foreclosed' : 'grace'

  return buildClaim({
    claim_class: marketContextClaimClass(domain),
    source_ref: projectionRef,
    source_owner: `market-context:${domain}`,
    lane: domain,
    status,
    observed_at: projection.updated_at ?? projection.created_at,
    last_heartbeat_at: heartbeatAt,
    fresh_until: freshUntil.toISOString(),
    live_authority_ref: projection.run_name ? `market-context-run:${projection.run_name}` : null,
    projection_ref: projectionRef,
    authority_state: authorityState,
    reason_codes:
      authorityState === 'stale_foreclosed'
        ? [`market_context_${domain}_projection_not_renewed`, 'market_context_completed_receipt_required']
        : [`market_context_${domain}_projection_inside_grace_budget`],
    value_gates: ['failed_agentrun_rate', 'manual_intervention_count', 'ready_status_truth'],
  })
}

const classifyTorghutRouteCustody = (input: ProjectionForeclosureNotaryInput): ProjectionForeclosureClaim | null => {
  const evidence = input.torghutConsumerEvidence
  if (evidence.status === 'disabled') return null

  const custodyStatus = normalizeStatus(evidence.evidence_clock_custody_status ?? evidence.status)
  const freshUntil = parseDate(evidence.fresh_until)
  const sourceRef = `torghut-consumer-evidence:${evidence.receipt_id ?? custodyStatus}`
  const evidenceRefs = uniqueStrings([
    evidence.receipt_id,
    evidence.evidence_clock_arbiter_id,
    evidence.evidence_clock_custody_ref,
    evidence.route_warrant_id,
  ])

  let authorityState: ProjectionForeclosureAuthorityState = 'authoritative'
  let reasonCodes = ['torghut_route_custody_current']

  if (custodyStatus === 'current' && freshUntil && freshUntil.getTime() < input.now.getTime()) {
    authorityState = 'missing_receipt'
    reasonCodes = ['torghut_route_custody_receipt_expired']
  } else if (custodyStatus !== 'current') {
    authorityState = custodyStatus === 'unavailable' || custodyStatus === 'unknown' ? 'unknown' : 'missing_receipt'
    reasonCodes = uniqueStrings([
      `evidence_clock_custody_${custodyStatus}`,
      ...((evidence.evidence_clock_blocking_reason_codes ?? []) as string[]),
      ...((evidence.route_warrant_blocking_reason_codes ?? []) as string[]),
      ...evidence.reason_codes,
    ])
  }

  return buildClaim({
    claim_class: 'torghut_route_custody',
    source_ref: sourceRef,
    source_owner: 'torghut',
    lane: 'torghut',
    status: custodyStatus,
    observed_at: evidence.generated_at,
    last_heartbeat_at: evidence.generated_at,
    fresh_until: evidence.fresh_until,
    live_authority_ref: evidence.evidence_clock_custody_ref ?? null,
    projection_ref: sourceRef,
    authority_state: authorityState,
    reason_codes: [...reasonCodes, ...evidenceRefs.map((ref) => `evidence_ref:${ref}`)],
    value_gates: ['ready_status_truth', 'failed_agentrun_rate', 'handoff_evidence_quality'],
  })
}

const classifySourceRolloutTruth = (input: ProjectionForeclosureNotaryInput): ProjectionForeclosureClaim => {
  const exchange = input.sourceRolloutTruthExchange
  const state = exchange.deployer_summary.settlement_state
  const authorityState: ProjectionForeclosureAuthorityState =
    state === 'converged'
      ? 'authoritative'
      : state === 'rollout_lagging_source' || state === 'heartbeat_projection_split'
        ? 'contradictory'
        : state === 'proof_floor_repair_only' || state === 'consumer_evidence_missing'
          ? 'missing_receipt'
          : 'unknown'

  return buildClaim({
    claim_class: 'source_rollout_truth',
    source_ref: exchange.exchange_id,
    source_owner: 'jangar',
    lane: 'deployer',
    status: state,
    observed_at: exchange.generated_at,
    last_heartbeat_at: exchange.generated_at,
    fresh_until: exchange.fresh_until,
    live_authority_ref: exchange.live_images[0]?.evidence_ref ?? null,
    projection_ref: exchange.exchange_id,
    authority_state: authorityState,
    reason_codes:
      authorityState === 'authoritative'
        ? ['source_rollout_truth_converged']
        : uniqueStrings([
            `source_rollout_truth_${state}`,
            exchange.deployer_summary.freshest_blocking_reason,
            ...exchange.receipts.flatMap((receipt) => receipt.blocking_reasons),
          ]),
    value_gates: ['pr_to_rollout_latency', 'ready_status_truth', 'handoff_evidence_quality'],
  })
}

const classifyStageClearancePacket = (input: ProjectionForeclosureNotaryInput, packet: StageClearancePacket) => {
  const freshUntil = parseDate(packet.fresh_until)
  const stale = !freshUntil || freshUntil.getTime() < input.now.getTime()
  return buildClaim({
    claim_class: 'stage_clearance',
    source_ref: packet.packet_id,
    source_owner: packet.swarm_name,
    lane: packet.stage,
    status: packet.decision,
    observed_at: packet.generated_at,
    last_heartbeat_at: packet.generated_at,
    fresh_until: packet.fresh_until,
    live_authority_ref: null,
    projection_ref: packet.packet_id,
    authority_state: stale ? 'stale_foreclosed' : 'authoritative',
    reason_codes: stale
      ? ['stage_clearance_packet_expired']
      : [`stage_clearance_${packet.decision}`, ...packet.reason_codes],
    value_gates: ['ready_status_truth', 'manual_intervention_count'],
  })
}

const collectionErrorClaims = (input: ProjectionForeclosureNotaryInput) =>
  input.collectionErrors.map((error) =>
    buildClaim({
      claim_class: 'agentrun_execution',
      source_ref: `projection-foreclosure-collection-error:${hashJson(error, 10)}`,
      source_owner: 'jangar',
      lane: null,
      status: 'collection_error',
      observed_at: input.now.toISOString(),
      last_heartbeat_at: null,
      fresh_until: null,
      live_authority_ref: null,
      projection_ref: null,
      authority_state: 'unknown',
      reason_codes: ['projection_foreclosure_collection_error', error],
      value_gates: ['ready_status_truth', 'handoff_evidence_quality'],
    }),
  )

const emptyTotals = (): ProjectionForeclosureClaimTotalsByState =>
  AUTHORITY_STATES.reduce((totals, state) => {
    totals[state] = 0
    return totals
  }, {} as ProjectionForeclosureClaimTotalsByState)

const claimTotals = (claims: ProjectionForeclosureClaim[]) => {
  const totals = emptyTotals()
  for (const claim of claims) {
    totals[claim.authority_state] += 1
  }
  return totals
}

const summarizeStates = (claims: ProjectionForeclosureClaim[], states: ProjectionForeclosureAuthorityState[]) => {
  const totals = emptyTotals()
  for (const claim of claims) {
    if (states.includes(claim.authority_state)) totals[claim.authority_state] += 1
  }
  return totals
}

const decide = (claims: ProjectionForeclosureClaim[]): ProjectionForeclosureDecision => {
  if (claims.some((claim) => claim.authority_state === 'unknown' || claim.authority_state === 'contradictory')) {
    return 'hold'
  }
  if (claims.some((claim) => claim.authority_state === 'missing_receipt')) return 'repair_only'
  if (claims.some((claim) => claim.authority_state === 'stale_foreclosed')) return 'observe_only'
  return 'allow'
}

const buildReceipts = (claims: ProjectionForeclosureClaim[]): ProjectionForeclosureReceipt[] =>
  claims
    .filter((claim) => claim.authority_state === 'stale_foreclosed' || claim.authority_state === 'terminal_audit')
    .map((claim) => ({
      receipt_id: receiptId(claim),
      claim_id: claim.claim_id,
      claim_class: claim.claim_class,
      authority_state: claim.authority_state,
      source_ref: claim.source_ref,
      projection_ref: claim.projection_ref,
      live_authority_ref: claim.live_authority_ref,
      reason_codes: claim.reason_codes,
      value_gates: claim.value_gates,
    }))

const missingReceiptsForClaim = (claim: ProjectionForeclosureClaim): ProjectionMissingReceipt[] => {
  if (claim.authority_state !== 'missing_receipt') return []
  if (claim.claim_class === 'torghut_route_custody') {
    return [
      {
        missing_receipt_id: `missing-receipt:${hashJson([claim.claim_id, 'execution-tca'], 12)}`,
        claim_id: claim.claim_id,
        claim_class: claim.claim_class,
        required_receipt_schema: 'torghut.execution-tca-refresh-receipt.v1',
        required_repair_action: 'attach current Torghut execution TCA refresh receipt',
        reason_codes: claim.reason_codes,
        evidence_refs: uniqueStrings([claim.source_ref, claim.projection_ref, claim.live_authority_ref]),
      },
      {
        missing_receipt_id: `missing-receipt:${hashJson([claim.claim_id, 'market-context'], 12)}`,
        claim_id: claim.claim_id,
        claim_class: claim.claim_class,
        required_receipt_schema: 'torghut.market-context-freshness-receipt.v1',
        required_repair_action: 'attach current Torghut market-context freshness receipt',
        reason_codes: claim.reason_codes,
        evidence_refs: uniqueStrings([claim.source_ref, claim.projection_ref, claim.live_authority_ref]),
      },
    ]
  }

  return [
    {
      missing_receipt_id: `missing-receipt:${hashJson([claim.claim_id, claim.claim_class], 12)}`,
      claim_id: claim.claim_id,
      claim_class: claim.claim_class,
      required_receipt_schema: `${claim.claim_class}.receipt.v1`,
      required_repair_action: `attach current ${claim.claim_class.replace(/_/g, ' ')} receipt`,
      reason_codes: claim.reason_codes,
      evidence_refs: uniqueStrings([claim.source_ref, claim.projection_ref, claim.live_authority_ref]),
    },
  ]
}

const stageCustodyVerdict = (input: ProjectionForeclosureNotaryInput) => {
  const evidence = input.torghutConsumerEvidence
  const custodyStatus = evidence.evidence_clock_custody_status ?? null
  const evidenceRefs = uniqueStrings([
    evidence.receipt_id,
    evidence.evidence_clock_arbiter_id,
    evidence.evidence_clock_custody_ref,
    evidence.route_warrant_id,
  ])
  if (custodyStatus === 'current') {
    return {
      decision: 'current' as const,
      evidence_clock_custody_status: custodyStatus,
      evidence_clock_custody_ref: evidence.evidence_clock_custody_ref ?? null,
      max_notional: evidence.max_notional,
      reason_codes: [],
      evidence_refs: evidenceRefs,
    }
  }
  if (!custodyStatus && evidence.status === 'disabled') {
    return {
      decision: 'unknown' as const,
      evidence_clock_custody_status: null,
      evidence_clock_custody_ref: null,
      max_notional: evidence.max_notional,
      reason_codes: ['torghut_consumer_evidence_disabled'],
      evidence_refs: evidenceRefs,
    }
  }
  return {
    decision: evidence.status === 'unavailable' ? ('hold' as const) : ('repair_only' as const),
    evidence_clock_custody_status: custodyStatus,
    evidence_clock_custody_ref: evidence.evidence_clock_custody_ref ?? null,
    max_notional: evidence.max_notional,
    reason_codes: uniqueStrings([
      custodyStatus ? `evidence_clock_custody_${custodyStatus}` : 'evidence_clock_custody_missing',
      ...evidence.reason_codes,
    ]).map(normalizeStatus),
    evidence_refs: evidenceRefs,
  }
}

const requiredRepairActions = (claims: ProjectionForeclosureClaim[], missingReceipts: ProjectionMissingReceipt[]) =>
  uniqueStrings([
    ...missingReceipts.map((receipt) => receipt.required_repair_action),
    ...claims.flatMap((claim) => {
      if (claim.authority_state === 'stale_foreclosed') return [`renew or retire ${claim.claim_class} projection`]
      if (claim.authority_state === 'unknown') return [`restore projection notary evidence for ${claim.claim_class}`]
      if (claim.authority_state === 'contradictory') return [`settle contradictory ${claim.claim_class} authority`]
      return []
    }),
  ])

export const buildProjectionForeclosureNotary = (
  input: ProjectionForeclosureNotaryInput,
): ProjectionForeclosureNotary => {
  const claims = [
    ...input.agentRunProjections.map((projection) => classifyAgentRunProjection(input, projection)),
    ...input.marketContextProjections.map((projection) => classifyMarketContextProjection(input, projection)),
    classifyTorghutRouteCustody(input),
    classifySourceRolloutTruth(input),
    ...input.stageClearancePackets.map((packet) => classifyStageClearancePacket(input, packet)),
    ...collectionErrorClaims(input),
  ].filter((claim): claim is ProjectionForeclosureClaim => Boolean(claim))
  const totals = claimTotals(claims)
  const foreclosureReceipts = buildReceipts(claims)
  const missingReceipts = claims.flatMap(missingReceiptsForClaim)
  const decision = decide(claims)
  const notaryDigest = hashJson({
    namespace: input.namespace,
    decision,
    claims: claims.map((claim) => [claim.claim_id, claim.authority_state, claim.status]),
    producer_revision: PRODUCER_REVISION,
  })

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: input.now.toISOString(),
    fresh_until: addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString(),
    namespace: input.namespace,
    source_revision: {
      source_head_sha: input.sourceHeadSha,
      gitops_revision: input.gitopsRevision,
    },
    decision,
    notary_id: `projection-foreclosure-notary:${input.namespace}:${notaryDigest}`,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    active_authority_summary: summarizeStates(claims, [
      'authoritative',
      'grace',
      'contradictory',
      'missing_receipt',
      'unknown',
    ]),
    stale_projection_summary: summarizeStates(claims, ['stale_foreclosed', 'terminal_audit']),
    claim_totals_by_state: totals,
    stage_custody_verdict: stageCustodyVerdict(input),
    claims,
    foreclosure_receipts: foreclosureReceipts,
    missing_receipts: missingReceipts,
    required_repair_actions: requiredRepairActions(claims, missingReceipts),
    rollback_target: DEFAULT_ROLLBACK_TARGET,
  }
}
