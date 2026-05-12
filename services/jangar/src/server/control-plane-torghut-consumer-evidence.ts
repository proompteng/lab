import { createHash } from 'node:crypto'

import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import type { TorghutNegativeEvidenceInput } from '~/server/control-plane-negative-evidence-router'
import { asRecord } from '~/server/primitives-http'

export type TorghutConsumerEvidenceStatus = {
  status: 'disabled' | 'current' | 'stale' | 'missing' | 'unavailable' | 'route_missing' | 'schema_mismatch'
  endpoint: string
  receipt_id: string | null
  generated_at: string | null
  fresh_until: string | null
  candidate_id: string | null
  dataset_snapshot_ref: string | null
  max_notional: string | null
  route_canary_id?: string | null
  jangar_parity_escrow_ref?: string | null
  serving_revision?: string | null
  image_digest?: string | null
  route_repair_value?: number | null
  decision?: string | null
  capital_reentry_cohort_ledger_id?: string | null
  capital_reentry_aggregate_state?: string | null
  capital_reentry_cohort_ids?: string[]
  profit_repair_settlement_ledger_id?: string | null
  profit_repair_aggregate_state?: string | null
  profit_repair_lot_ids?: string[]
  routeability_repair_acceptance_ledger_id?: string | null
  routeability_aggregate_state?: string | null
  routeability_lot_ids?: string[]
  accepted_routeable_candidate_count?: number | null
  profit_freshness_frontier_id?: string | null
  profit_freshness_state?: string | null
  profit_freshness_repair_lot_ids?: string[]
  profit_freshness_selected_repair_ids?: string[]
  reason_codes: string[]
  message: string
}

export type TorghutConsumerEvidenceResolution = {
  status: TorghutConsumerEvidenceStatus
  negativeEvidence?: TorghutNegativeEvidenceInput
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const normalizeNonEmpty = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeReason = (value: unknown) =>
  normalizeNonEmpty(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const stringList = (value: unknown) =>
  Array.isArray(value) ? uniqueStrings(value.map((item) => normalizeReason(item))) : []

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const parseNumber = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const CONSUMER_EVIDENCE_STATUS_SCHEMA_VERSION = 'torghut.consumer-evidence-status.v1'
const CONSUMER_EVIDENCE_RECEIPT_SCHEMA_VERSION = 'torghut.consumer-evidence-receipt.v1'
const ROUTE_PROVEN_PROFIT_RECEIPT_SCHEMA_VERSION = 'torghut.route-proven-profit-receipt.v1'

type JsonRouteResult = {
  ok: boolean
  statusCode: number | null
  payload: Record<string, unknown> | null
}

const requestJson = async (url: string, timeoutMs: number): Promise<JsonRouteResult> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: response.ok, statusCode: response.status, payload: null }
    }
    return { ok: response.ok, statusCode: response.status, payload: payload as Record<string, unknown> }
  } catch {
    return { ok: false, statusCode: null, payload: null }
  } finally {
    clearTimeout(timeout)
  }
}

const readMarketContext = (
  payload: Record<string, unknown>,
): Pick<TorghutNegativeEvidenceInput, 'market_context_status' | 'market_context_stale_domains'> => {
  const marketContext = asRecord(payload.market_context)
  const health = asRecord(marketContext?.health)
  const status = normalizeNonEmpty(health?.status ?? marketContext?.status ?? marketContext?.last_reason)
  const domains = asRecord(marketContext?.last_domain_states)
  const staleDomains =
    domains && typeof domains === 'object'
      ? Object.entries(domains)
          .filter(([, value]) => {
            const domain = asRecord(value)
            return normalizeNonEmpty(domain?.status) === 'stale' || domain?.stale === true
          })
          .map(([key]) => key)
      : []

  if (status === 'ok' || status === 'healthy') {
    return { market_context_status: 'healthy', market_context_stale_domains: staleDomains }
  }
  if (status === 'stale') {
    return { market_context_status: 'stale', market_context_stale_domains: staleDomains }
  }
  if (status === 'degraded') {
    return { market_context_status: 'degraded', market_context_stale_domains: staleDomains }
  }
  return { market_context_status: undefined, market_context_stale_domains: staleDomains }
}

export const resolveTorghutConsumerEvidence = async (now = new Date()): Promise<TorghutConsumerEvidenceResolution> => {
  const config = resolveControlPlaneStatusConfig(process.env)
  const endpoint = config.torghutStatusUrl ?? ''
  if (!endpoint) {
    return {
      status: {
        status: 'disabled',
        endpoint,
        receipt_id: null,
        generated_at: null,
        fresh_until: null,
        candidate_id: null,
        dataset_snapshot_ref: null,
        max_notional: null,
        reason_codes: [],
        message: 'torghut consumer evidence endpoint not configured',
      },
    }
  }

  const routeResult = await requestJson(endpoint, config.torghutStatusTimeoutMs)
  if (!routeResult.ok) {
    const routeMissing = routeResult.statusCode === 404
    const status = routeMissing ? 'route_missing' : 'unavailable'
    const reason = routeMissing ? 'torghut_consumer_evidence_route_missing' : 'torghut_consumer_evidence_unavailable'
    return {
      status: {
        status,
        endpoint,
        receipt_id: null,
        generated_at: null,
        fresh_until: null,
        candidate_id: null,
        dataset_snapshot_ref: null,
        max_notional: null,
        reason_codes: [reason],
        message: routeMissing
          ? 'torghut consumer evidence route returned 404'
          : 'torghut consumer evidence endpoint unavailable',
      },
      negativeEvidence: {
        readiness_status: 'degraded',
        readyz_status_code: routeResult.statusCode,
        paper_settlement_clean: false,
        consumer_evidence_receipt_id: null,
        consumer_evidence_status: status,
        consumer_evidence_fresh_until: null,
        consumer_evidence_reason_codes: [reason],
      },
    }
  }

  const payload = routeResult.payload ?? {}
  const payloadSchema = normalizeNonEmpty(payload.schema_version)
  if (payloadSchema && payloadSchema !== CONSUMER_EVIDENCE_STATUS_SCHEMA_VERSION) {
    return {
      status: {
        status: 'schema_mismatch',
        endpoint,
        receipt_id: null,
        generated_at: null,
        fresh_until: null,
        candidate_id: null,
        dataset_snapshot_ref: null,
        max_notional: null,
        reason_codes: ['torghut_consumer_evidence_schema_mismatch'],
        message: `torghut consumer evidence status schema mismatch: ${payloadSchema}`,
      },
      negativeEvidence: {
        readiness_status: 'degraded',
        readyz_status_code: routeResult.statusCode,
        paper_settlement_clean: false,
        consumer_evidence_receipt_id: null,
        consumer_evidence_status: 'schema_mismatch',
        consumer_evidence_fresh_until: null,
        consumer_evidence_reason_codes: ['torghut_consumer_evidence_schema_mismatch'],
      },
    }
  }

  const routeProvenReceipt = asRecord(payload.route_proven_profit_receipt)
  const compatibilityReceipt = asRecord(payload.torghut_consumer_evidence_receipt ?? payload.consumer_evidence_receipt)
  const receipt = routeProvenReceipt ?? compatibilityReceipt
  if (!receipt) {
    return {
      status: {
        status: 'missing',
        endpoint,
        receipt_id: null,
        generated_at: null,
        fresh_until: null,
        candidate_id: null,
        dataset_snapshot_ref: null,
        max_notional: null,
        reason_codes: ['torghut_consumer_evidence_missing'],
        message: 'torghut status payload did not include torghut_consumer_evidence_receipt',
      },
    }
  }

  const receiptSchema = normalizeNonEmpty(receipt.schema_version)
  const expectedReceiptSchema = routeProvenReceipt
    ? ROUTE_PROVEN_PROFIT_RECEIPT_SCHEMA_VERSION
    : CONSUMER_EVIDENCE_RECEIPT_SCHEMA_VERSION
  if (receiptSchema && receiptSchema !== expectedReceiptSchema) {
    const receiptId = normalizeNonEmpty(receipt.receipt_id)
    return {
      status: {
        status: 'schema_mismatch',
        endpoint,
        receipt_id: receiptId,
        generated_at: normalizeNonEmpty(receipt.generated_at),
        fresh_until: normalizeNonEmpty(receipt.fresh_until),
        candidate_id: normalizeNonEmpty(receipt.candidate_id),
        dataset_snapshot_ref: normalizeNonEmpty(receipt.dataset_snapshot_ref),
        max_notional: normalizeNonEmpty(receipt.max_notional),
        reason_codes: ['torghut_consumer_evidence_receipt_schema_mismatch'],
        message: `torghut consumer evidence receipt schema mismatch: ${receiptSchema}`,
      },
      negativeEvidence: {
        readiness_status: 'degraded',
        readyz_status_code: routeResult.statusCode,
        ...readMarketContext(payload ?? {}),
        paper_settlement_clean: false,
        consumer_evidence_receipt_id: receiptId,
        consumer_evidence_status: 'schema_mismatch',
        consumer_evidence_fresh_until: normalizeNonEmpty(receipt.fresh_until),
        consumer_evidence_reason_codes: ['torghut_consumer_evidence_receipt_schema_mismatch'],
      },
    }
  }

  const receiptId =
    normalizeNonEmpty(receipt.receipt_id) ??
    `torghut-consumer-evidence:${hashJson({
      generated_at: receipt.generated_at,
      candidate_id: receipt.candidate_id,
      dataset_snapshot_ref: receipt.dataset_snapshot_ref,
      reason_codes: receipt.reason_codes,
    })}`
  const generatedAt = normalizeNonEmpty(receipt.generated_at)
  const freshUntil = normalizeNonEmpty(receipt.fresh_until)
  const freshUntilMs = parseTimestampMs(freshUntil)
  const status = freshUntilMs && freshUntilMs > now.getTime() ? 'current' : 'stale'
  const reasonCodes = uniqueStrings([
    ...(status === 'current' ? [] : ['torghut_consumer_evidence_stale']),
    ...stringList(receipt.reason_codes),
  ])
  const maxNotional = normalizeNonEmpty(receipt.max_notional)
  const paperReadinessState = normalizeNonEmpty(receipt.paper_readiness_state)
  const liveReadinessState = normalizeNonEmpty(receipt.live_readiness_state)
  const readyzStatusCode = normalizeNonEmpty(asRecord(payload.readiness)?.status_code)
  const marketContext = readMarketContext(payload)
  const cohortLedger = asRecord(payload.capital_reentry_cohort_ledger)
  const cohortRows = Array.isArray(cohortLedger?.cohorts)
    ? cohortLedger.cohorts
        .map((cohort) => asRecord(cohort))
        .filter((cohort): cohort is Record<string, unknown> => Boolean(cohort))
    : []
  const capitalReentryCohortIds = uniqueStrings(cohortRows.map((cohort) => normalizeNonEmpty(cohort.cohort_id)))
  const capitalReentryReasonCodes = uniqueStrings([
    ...stringList(cohortLedger?.aggregate_blocking_reason_codes),
    ...cohortRows.flatMap((cohort) => stringList(cohort.blocking_reason_codes)),
  ])
  const capitalReentryAggregateState = normalizeNonEmpty(cohortLedger?.aggregate_state)
  const capitalReentryLedgerId = normalizeNonEmpty(cohortLedger?.ledger_id)
  const profitRepairLedger = asRecord(payload.profit_repair_settlement_ledger)
  const profitRepairLots = Array.isArray(profitRepairLedger?.repair_lots)
    ? profitRepairLedger.repair_lots
        .map((lot) => asRecord(lot))
        .filter((lot): lot is Record<string, unknown> => Boolean(lot))
    : []
  const profitRepairLotIds = uniqueStrings(profitRepairLots.map((lot) => normalizeNonEmpty(lot.lot_id)))
  const profitRepairReasonCodes = uniqueStrings([
    ...stringList(profitRepairLedger?.aggregate_blocking_reason_codes),
    ...profitRepairLots.flatMap((lot) => stringList(lot.blocking_reason_codes)),
  ])
  const profitRepairAggregateState = normalizeNonEmpty(profitRepairLedger?.aggregate_state)
  const profitRepairLedgerId = normalizeNonEmpty(profitRepairLedger?.ledger_id)
  const routeabilityLedger = asRecord(payload.routeability_repair_acceptance_ledger)
  const routeabilityLots = Array.isArray(routeabilityLedger?.lots)
    ? routeabilityLedger.lots.map((lot) => asRecord(lot)).filter((lot): lot is Record<string, unknown> => Boolean(lot))
    : []
  const routeabilityLotIds = uniqueStrings(routeabilityLots.map((lot) => normalizeNonEmpty(lot.lot_id)))
  const routeabilityReasonCodes = uniqueStrings([
    ...stringList(routeabilityLedger?.aggregate_blocking_reason_codes),
    ...routeabilityLots.flatMap((lot) => stringList(lot.blocking_reason_codes)),
  ])
  const routeabilityAggregateState = normalizeNonEmpty(routeabilityLedger?.aggregate_state)
  const routeabilityLedgerId = normalizeNonEmpty(routeabilityLedger?.ledger_id)
  const acceptedRouteableCandidateCount = parseNumber(
    normalizeNonEmpty(routeabilityLedger?.accepted_routeable_candidate_count),
  )
  const profitFreshnessFrontier = asRecord(payload.profit_freshness_frontier)
  const profitFreshnessLots = Array.isArray(profitFreshnessFrontier?.repair_lots)
    ? profitFreshnessFrontier.repair_lots
        .map((lot) => asRecord(lot))
        .filter((lot): lot is Record<string, unknown> => Boolean(lot))
    : []
  const profitFreshnessSelectedRepairs = Array.isArray(profitFreshnessFrontier?.selected_zero_notional_repairs)
    ? profitFreshnessFrontier.selected_zero_notional_repairs
        .map((lot) => asRecord(lot))
        .filter((lot): lot is Record<string, unknown> => Boolean(lot))
    : []
  const profitFreshnessRepairLotIds = uniqueStrings(profitFreshnessLots.map((lot) => normalizeNonEmpty(lot.lot_id)))
  const profitFreshnessSelectedRepairIds = uniqueStrings(
    profitFreshnessSelectedRepairs.map((lot) => normalizeNonEmpty(lot.lot_id)),
  )
  const profitFreshnessReasonCodes = uniqueStrings([
    ...stringList(profitFreshnessFrontier?.aggregate_blocking_reason_codes),
    ...profitFreshnessLots.flatMap((lot) => stringList(lot.guardrail_failures)),
  ])
  const profitFreshnessState = normalizeNonEmpty(
    profitFreshnessFrontier?.frontier_state ?? profitFreshnessFrontier?.aggregate_state,
  )
  const profitFreshnessFrontierId = normalizeNonEmpty(profitFreshnessFrontier?.frontier_id)

  return {
    status: {
      status,
      endpoint,
      receipt_id: receiptId,
      generated_at: generatedAt,
      fresh_until: freshUntil,
      candidate_id: normalizeNonEmpty(receipt.candidate_id),
      dataset_snapshot_ref: normalizeNonEmpty(receipt.dataset_snapshot_ref),
      max_notional: maxNotional,
      route_canary_id: normalizeNonEmpty(receipt.route_canary_id),
      jangar_parity_escrow_ref: normalizeNonEmpty(receipt.jangar_parity_escrow_ref),
      serving_revision: normalizeNonEmpty(receipt.serving_revision),
      image_digest: normalizeNonEmpty(receipt.image_digest),
      route_repair_value: parseNumber(normalizeNonEmpty(receipt.route_repair_value)),
      decision: normalizeNonEmpty(receipt.decision),
      capital_reentry_cohort_ledger_id: capitalReentryLedgerId,
      capital_reentry_aggregate_state: capitalReentryAggregateState,
      capital_reentry_cohort_ids: capitalReentryCohortIds,
      profit_repair_settlement_ledger_id: profitRepairLedgerId,
      profit_repair_aggregate_state: profitRepairAggregateState,
      profit_repair_lot_ids: profitRepairLotIds,
      routeability_repair_acceptance_ledger_id: routeabilityLedgerId,
      routeability_aggregate_state: routeabilityAggregateState,
      routeability_lot_ids: routeabilityLotIds,
      accepted_routeable_candidate_count: acceptedRouteableCandidateCount,
      profit_freshness_frontier_id: profitFreshnessFrontierId,
      profit_freshness_state: profitFreshnessState,
      profit_freshness_repair_lot_ids: profitFreshnessRepairLotIds,
      profit_freshness_selected_repair_ids: profitFreshnessSelectedRepairIds,
      reason_codes: reasonCodes,
      message:
        status === 'current'
          ? 'torghut consumer evidence receipt current'
          : 'torghut consumer evidence receipt stale or missing freshness',
    },
    negativeEvidence: {
      readiness_status:
        paperReadinessState === 'ready' && liveReadinessState !== 'blocked' && reasonCodes.length === 0
          ? 'healthy'
          : 'degraded',
      readyz_status_code: parseNumber(readyzStatusCode),
      ...marketContext,
      paper_settlement_clean: paperReadinessState === 'ready' && reasonCodes.length === 0,
      consumer_evidence_receipt_id: receiptId,
      consumer_evidence_status: status,
      consumer_evidence_fresh_until: freshUntil,
      consumer_evidence_reason_codes: reasonCodes,
      capital_reentry_cohort_ledger_id: capitalReentryLedgerId,
      capital_reentry_aggregate_state: capitalReentryAggregateState,
      capital_reentry_cohort_ids: capitalReentryCohortIds,
      capital_reentry_blocking_reason_codes: capitalReentryReasonCodes,
      profit_repair_settlement_ledger_id: profitRepairLedgerId,
      profit_repair_aggregate_state: profitRepairAggregateState,
      profit_repair_lot_ids: profitRepairLotIds,
      profit_repair_blocking_reason_codes: profitRepairReasonCodes,
      routeability_repair_acceptance_ledger_id: routeabilityLedgerId,
      routeability_aggregate_state: routeabilityAggregateState,
      routeability_lot_ids: routeabilityLotIds,
      routeability_blocking_reason_codes: routeabilityReasonCodes,
      accepted_routeable_candidate_count: acceptedRouteableCandidateCount,
      profit_freshness_frontier_id: profitFreshnessFrontierId,
      profit_freshness_state: profitFreshnessState,
      profit_freshness_repair_lot_ids: profitFreshnessRepairLotIds,
      profit_freshness_selected_repair_ids: profitFreshnessSelectedRepairIds,
      profit_freshness_blocking_reason_codes: profitFreshnessReasonCodes,
    },
  }
}
