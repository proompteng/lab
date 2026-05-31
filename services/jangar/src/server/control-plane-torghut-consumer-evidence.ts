import { createHash } from 'node:crypto'

import type {
  TorghutConsumerEvidenceStatus,
  TorghutRepairBidSettlementLot,
  TorghutRepairBidSettlementStatus,
} from '~/server/control-plane-status-types'
import {
  deriveRevenueRepairEndpoint,
  readAlphaReadinessStrikeLedger,
} from '~/server/control-plane-torghut-alpha-readiness-strike'
import {
  readAlphaEvidenceFoundry,
  readAlphaRepairClosureBoard,
} from '~/server/control-plane-torghut-alpha-closure-evidence'
import {
  alphaReadinessSettlementConveyorRefSchemaMismatch,
  readAlphaReadinessSettlementConveyorRef,
} from '~/server/control-plane-torghut-alpha-readiness-settlement-conveyor'
import {
  alphaRepairDividendLedgerRefSchemaMismatch,
  readAlphaRepairDividendLedgerRef,
} from '~/server/control-plane-torghut-alpha-repair-dividend-ledger'
import {
  alphaClosureDividendSloSchemaMismatch,
  readAlphaClosureDividendSlo,
} from '~/server/control-plane-torghut-alpha-closure-dividend-slo'
import {
  noDeltaRepairReentryAuctionRefSchemaMismatch,
  readNoDeltaRepairReentryAuctionRef,
} from '~/server/control-plane-torghut-no-delta-repair-reentry-auction'
import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import { readTorghutFreshnessCarryEvidence } from '~/server/control-plane-torghut-freshness-carry'
import { readTorghutRepairOutcomeEvidence } from '~/server/control-plane-torghut-repair-outcome'
import { readExecutableAlphaRepairReceipts } from '~/server/control-plane-torghut-executable-alpha-repair'
import {
  hasRevenueRepairSummary,
  normalizeRevenueRepairBoolean,
  readRevenueRepairQueue,
} from '~/server/control-plane-torghut-revenue-repair'
import { buildUnavailableStatusFromRevenueRepair } from '~/server/control-plane-torghut-revenue-repair-fallback'
import type { TorghutNegativeEvidenceInput } from '~/server/control-plane-negative-evidence-router-torghut'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  parseNumber,
  parseTimestampMs,
  stringList,
  stringValues,
  uniqueStrings,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { normalizeRepairBidSettlementLot } from '~/server/control-plane-torghut-repair-bid-settlement'
import { asRecord } from '@proompteng/agent-contracts'

export type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-status-types'

export type TorghutConsumerEvidenceResolution = {
  status: TorghutConsumerEvidenceStatus
  negativeEvidence?: TorghutNegativeEvidenceInput
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const paperActionStates = new Set(['allow', 'allowed', 'current', 'paper_canary', 'paper_candidate', 'ready'])

const CONSUMER_EVIDENCE_STATUS_SCHEMA_VERSION = 'torghut.consumer-evidence-status.v1'
const CONSUMER_EVIDENCE_RECEIPT_SCHEMA_VERSION = 'torghut.consumer-evidence-receipt.v1'
const ROUTE_PROVEN_PROFIT_RECEIPT_SCHEMA_VERSION = 'torghut.route-proven-profit-receipt.v1'
const ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION = 'torghut.route-warrant-exchange.v1'
const REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION = 'torghut.repair-bid-settlement-ledger.v1'

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

const hasRouteWarrantPayload = (payload: Record<string, unknown> | null | undefined) =>
  Boolean(
    payload && asRecord(payload.route_warrant_exchange ?? payload.route_warrant_exchange_v1 ?? payload.route_warrant),
  )

const compactConsumerEvidenceEndpoint = (endpoint: string): string => {
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, '')
    if (path.endsWith('/trading/consumer-evidence') && !url.searchParams.has('view')) {
      url.searchParams.set('view', 'summary')
      return url.toString()
    }
  } catch {
    return endpoint
  }
  return endpoint
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

  const compactEndpoint = compactConsumerEvidenceEndpoint(endpoint)
  const routeResult = await requestJson(compactEndpoint, config.torghutStatusTimeoutMs)
  if (!routeResult.ok) {
    const routeMissing = routeResult.statusCode === 404
    const status = routeMissing ? 'route_missing' : 'unavailable'
    const reason = routeMissing ? 'torghut_consumer_evidence_route_missing' : 'torghut_consumer_evidence_unavailable'
    const revenueRepairEndpoint = deriveRevenueRepairEndpoint(endpoint)
    const revenueRepairResult =
      revenueRepairEndpoint && revenueRepairEndpoint !== endpoint
        ? await requestJson(revenueRepairEndpoint, config.torghutStatusTimeoutMs)
        : null
    const revenueRepairPayload = hasRevenueRepairSummary(revenueRepairResult?.payload ?? {})
      ? (revenueRepairResult?.payload ?? null)
      : null
    return {
      status: buildUnavailableStatusFromRevenueRepair({
        endpoint,
        status,
        reason,
        payload: revenueRepairPayload,
        message: routeMissing
          ? 'torghut consumer evidence route returned 404'
          : 'torghut consumer evidence endpoint unavailable',
      }),
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
  const fullConsumerEvidenceResult =
    compactEndpoint !== endpoint &&
    (!hasRouteWarrantPayload(payload) ||
      !hasRevenueRepairSummary(payload) ||
      !readAlphaReadinessSettlementConveyorRef(payload))
      ? await requestJson(endpoint, config.torghutStatusTimeoutMs)
      : null
  const fullConsumerEvidencePayload =
    fullConsumerEvidenceResult?.ok && fullConsumerEvidenceResult.payload ? fullConsumerEvidenceResult.payload : null
  const primaryEvidencePayload = fullConsumerEvidencePayload ?? payload
  const inlineAlphaReadinessStrikeLedger =
    readAlphaReadinessStrikeLedger(primaryEvidencePayload) ?? readAlphaReadinessStrikeLedger(payload)
  const inlineExecutableAlphaRepairReceipts =
    readExecutableAlphaRepairReceipts(primaryEvidencePayload) ?? readExecutableAlphaRepairReceipts(payload)
  const revenueRepairEndpoint = deriveRevenueRepairEndpoint(endpoint)
  const revenueRepairResult =
    !fullConsumerEvidencePayload &&
    revenueRepairEndpoint &&
    revenueRepairEndpoint !== endpoint &&
    (!hasRevenueRepairSummary(payload) || !inlineAlphaReadinessStrikeLedger || !inlineExecutableAlphaRepairReceipts)
      ? await requestJson(revenueRepairEndpoint, config.torghutStatusTimeoutMs)
      : null
  const alphaReadinessStrikeLedger =
    inlineAlphaReadinessStrikeLedger ?? readAlphaReadinessStrikeLedger(revenueRepairResult?.payload ?? null)
  const executableAlphaRepairReceipts =
    inlineExecutableAlphaRepairReceipts ?? readExecutableAlphaRepairReceipts(revenueRepairResult?.payload ?? null)
  const revenueRepairPayload = hasRevenueRepairSummary(primaryEvidencePayload)
    ? primaryEvidencePayload
    : (revenueRepairResult?.payload ?? null)
  const revenueRepairBusinessState = normalizeReason(revenueRepairPayload?.business_state)
  const revenueRepairReady = normalizeRevenueRepairBoolean(revenueRepairPayload?.revenue_ready)
  const revenueRepairQueue = readRevenueRepairQueue(revenueRepairPayload)
  const sourceServingContractPayload = fullConsumerEvidencePayload ?? payload
  const alphaRepairClosureBoard =
    readAlphaRepairClosureBoard(primaryEvidencePayload) ??
    readAlphaRepairClosureBoard(payload) ??
    readAlphaRepairClosureBoard(revenueRepairPayload)
  const alphaEvidenceFoundry =
    readAlphaEvidenceFoundry(primaryEvidencePayload) ??
    readAlphaEvidenceFoundry(payload) ??
    readAlphaEvidenceFoundry(revenueRepairPayload)
  const alphaReadinessSettlementConveyor =
    readAlphaReadinessSettlementConveyorRef(primaryEvidencePayload) ??
    readAlphaReadinessSettlementConveyorRef(payload) ??
    readAlphaReadinessSettlementConveyorRef(revenueRepairPayload)
  const alphaRepairDividendLedger =
    readAlphaRepairDividendLedgerRef(primaryEvidencePayload) ??
    readAlphaRepairDividendLedgerRef(payload) ??
    readAlphaRepairDividendLedgerRef(revenueRepairPayload)
  const alphaClosureDividendSlo =
    readAlphaClosureDividendSlo(primaryEvidencePayload) ??
    readAlphaClosureDividendSlo(payload) ??
    readAlphaClosureDividendSlo(revenueRepairPayload)
  const noDeltaRepairReentryAuction =
    readNoDeltaRepairReentryAuctionRef(primaryEvidencePayload) ??
    readNoDeltaRepairReentryAuctionRef(payload) ??
    readNoDeltaRepairReentryAuctionRef(revenueRepairPayload)
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
  const receiptReasonCodes = uniqueStrings([
    ...(status === 'current' ? [] : ['torghut_consumer_evidence_stale']),
    ...stringList(receipt.reason_codes),
  ])
  const maxNotional = normalizeNonEmpty(receipt.max_notional)
  const build = asRecord(payload.build)
  const buildCommit = normalizeNonEmpty(
    build?.commit ?? payload.build_commit ?? receipt.build_commit ?? receipt.source_commit,
  )
  const buildVersion = normalizeNonEmpty(build?.version ?? build?.build_version ?? payload.build_version)
  const servingRevision =
    normalizeNonEmpty(receipt.serving_revision) ??
    normalizeNonEmpty(build?.active_revision ?? build?.serving_revision ?? payload.serving_revision)
  const servingImageDigest = normalizeNonEmpty(
    build?.image_digest ?? build?.serving_image_digest ?? payload.image_digest ?? receipt.image_digest,
  )
  const paperReadinessState = normalizeNonEmpty(receipt.paper_readiness_state)
  const liveReadinessState = normalizeNonEmpty(receipt.live_readiness_state)
  const readyzStatusCode = normalizeNonEmpty(asRecord(payload.readiness)?.status_code)
  const marketContext = readMarketContext(payload)
  const cohortLedger = asRecord(primaryEvidencePayload.capital_reentry_cohort_ledger)
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
  const profitRepairLedger = asRecord(primaryEvidencePayload.profit_repair_settlement_ledger)
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
  const routeabilityLedger = asRecord(primaryEvidencePayload.routeability_repair_acceptance_ledger)
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
  const profitFreshnessFrontier = asRecord(primaryEvidencePayload.profit_freshness_frontier)
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
  const evidenceClockArbiter = asRecord(primaryEvidencePayload.evidence_clock_arbiter)
  const evidenceClockSplits = Array.isArray(evidenceClockArbiter?.clock_splits)
    ? evidenceClockArbiter.clock_splits
        .map((split) => asRecord(split))
        .filter((split): split is Record<string, unknown> => Boolean(split))
    : []
  const evidenceClockArbiterId = normalizeNonEmpty(evidenceClockArbiter?.arbiter_id)
  const evidenceClockState = evidenceClockArbiter ? (evidenceClockSplits.length > 0 ? 'split' : 'current') : 'missing'
  const evidenceClockSplitClockNames = uniqueStrings(evidenceClockSplits.map((split) => normalizeNonEmpty(split.clock)))
  const evidenceClockReasonCodes = uniqueStrings([
    ...stringList(evidenceClockArbiter?.reason_codes),
    ...evidenceClockSplits.flatMap((split) => stringList(split.reason_codes)),
  ])
  const custodyRef = asRecord(evidenceClockArbiter?.required_jangar_custody_ref)
  const custodyRefId = normalizeNonEmpty(
    custodyRef?.packet_id ?? custodyRef?.id ?? custodyRef?.receipt_id ?? custodyRef?.settlement_ref,
  )
  const custodyDecision = normalizeReason(custodyRef?.decision ?? custodyRef?.state ?? custodyRef?.status)
  const custodySource = normalizeReason(custodyRef?.source)
  const custodyFreshUntil = normalizeNonEmpty(custodyRef?.fresh_until)
  const custodyFreshUntilMs = parseTimestampMs(custodyFreshUntil)
  const evidenceClockCustodyStatus =
    !evidenceClockArbiter || !custodyRefId || custodySource !== 'stage_clearance_packet'
      ? 'missing'
      : !custodyFreshUntilMs || custodyFreshUntilMs <= now.getTime()
        ? 'stale'
        : custodyDecision && paperActionStates.has(custodyDecision)
          ? 'current'
          : 'blocked'
  const evidenceClockCustodyReasonCodes = uniqueStrings([
    ...stringList(custodyRef?.reason_codes),
    ...(evidenceClockCustodyStatus === 'missing' ? ['evidence_clock_custody_receipt_missing'] : []),
    ...(evidenceClockCustodyStatus === 'stale'
      ? [custodyFreshUntilMs ? 'evidence_clock_custody_stale' : 'evidence_clock_custody_fresh_until_missing']
      : []),
    ...(evidenceClockCustodyStatus === 'blocked' ? [`evidence_clock_custody_${custodyDecision ?? 'blocked'}`] : []),
  ])
  const routeableExchange = asRecord(primaryEvidencePayload.routeable_profit_candidate_exchange)
  const routeableExchangeSummary = asRecord(routeableExchange?.summary)
  const zeroNotionalRepairLots = Array.isArray(routeableExchange?.zero_notional_repair_lots)
    ? routeableExchange.zero_notional_repair_lots
        .map((lot) => asRecord(lot))
        .filter((lot): lot is Record<string, unknown> => Boolean(lot))
    : []
  const rejectedCandidates = Array.isArray(routeableExchange?.rejected_candidates)
    ? routeableExchange.rejected_candidates
        .map((candidate) => asRecord(candidate))
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
    : []
  const routeableExchangeId = normalizeNonEmpty(routeableExchange?.exchange_id)
  const routeableExchangeZeroNotionalRepairLotIds = uniqueStrings(
    zeroNotionalRepairLots.map((lot) => normalizeNonEmpty(lot.lot_id)),
  )
  const routeableExchangeRouteableCandidateCount = parseNumber(
    normalizeNonEmpty(
      routeableExchangeSummary?.routeable_candidate_count ?? routeableExchange?.routeable_candidate_count,
    ),
  )
  const routeableExchangeRejectedCandidateCount =
    parseNumber(normalizeNonEmpty(routeableExchangeSummary?.rejected_candidate_count)) ?? rejectedCandidates.length
  const topClockSplit = evidenceClockSplits[0]
  const selectedEvidenceClockRepair = zeroNotionalRepairLots[0]
  const routeWarrant = asRecord(
    sourceServingContractPayload.route_warrant_exchange ??
      sourceServingContractPayload.route_warrant_exchange_v1 ??
      sourceServingContractPayload.route_warrant ??
      primaryEvidencePayload.route_warrant_exchange ??
      primaryEvidencePayload.route_warrant_exchange_v1 ??
      primaryEvidencePayload.route_warrant,
  )
  const repairBidSettlement =
    asRecord(sourceServingContractPayload.repair_bid_settlement_ledger) ??
    asRecord(primaryEvidencePayload.repair_bid_settlement_ledger) ??
    asRecord(revenueRepairPayload?.repair_bid_settlement_ledger)
  const repairOutcome = readTorghutRepairOutcomeEvidence(primaryEvidencePayload)
  const sourceServingRepairReceiptLedger =
    asRecord(sourceServingContractPayload.source_serving_repair_receipt_ledger) ??
    asRecord(primaryEvidencePayload.source_serving_repair_receipt_ledger) ??
    asRecord(revenueRepairPayload?.source_serving_repair_receipt_ledger)
  const freshnessCarry = readTorghutFreshnessCarryEvidence(primaryEvidencePayload)
  const reasonCodes = uniqueStrings([...receiptReasonCodes, ...freshnessCarry.reasonCodes])
  const observedContracts = uniqueStrings([
    routeWarrant ? 'route_warrant_exchange' : null,
    repairBidSettlement ? 'repair_bid_settlement_ledger' : null,
    repairOutcome.present ? 'repair_outcome_dividend_ledger' : null,
    sourceServingRepairReceiptLedger ? 'source_serving_repair_receipt_ledger' : null,
    freshnessCarry.present ? 'freshness_carry_ledger' : null,
    routeabilityLedger ? 'routeability_repair_acceptance_ledger' : null,
    profitRepairLedger ? 'profit_repair_settlement_ledger' : null,
    routeableExchange ? 'routeable_profit_candidate_exchange' : null,
    alphaReadinessStrikeLedger ? 'alpha_readiness_strike_ledger' : null,
    executableAlphaRepairReceipts ? 'executable_alpha_repair_receipts' : null,
    alphaRepairClosureBoard ? 'alpha_repair_closure_board' : null,
    alphaEvidenceFoundry ? 'alpha_evidence_foundry' : null,
    alphaReadinessSettlementConveyor ? 'alpha_readiness_settlement_conveyor' : null,
    alphaRepairDividendLedger ? 'alpha_repair_dividend_ledger' : null,
    alphaClosureDividendSlo ? 'alpha_closure_dividend_slo' : null,
    noDeltaRepairReentryAuction ? 'no_delta_repair_reentry_auction' : null,
  ])
  const contractSchemaMismatches = uniqueStrings([
    routeWarrant &&
    normalizeNonEmpty(routeWarrant.schema_version) &&
    normalizeNonEmpty(routeWarrant.schema_version) !== ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION
      ? `route_warrant_exchange:${normalizeNonEmpty(routeWarrant.schema_version)}`
      : null,
    repairBidSettlement &&
    normalizeNonEmpty(repairBidSettlement.schema_version) &&
    normalizeNonEmpty(repairBidSettlement.schema_version) !== REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION
      ? `repair_bid_settlement_ledger:${normalizeNonEmpty(repairBidSettlement.schema_version)}`
      : null,
    repairOutcome.contractSchemaMismatch,
    freshnessCarry.contractSchemaMismatch,
    alphaReadinessSettlementConveyorRefSchemaMismatch(primaryEvidencePayload),
    alphaRepairDividendLedgerRefSchemaMismatch(primaryEvidencePayload),
    alphaClosureDividendSloSchemaMismatch(primaryEvidencePayload),
    noDeltaRepairReentryAuctionRefSchemaMismatch(primaryEvidencePayload),
  ])
  const routeWarrantId = normalizeNonEmpty(routeWarrant?.warrant_id ?? routeWarrant?.exchange_id)
  const routeWarrantRepairPackets = Array.isArray(routeWarrant?.repair_packets)
    ? routeWarrant.repair_packets
        .map((packet) => asRecord(packet))
        .filter((packet): packet is Record<string, unknown> => Boolean(packet))
    : []
  const routeWarrantWitnesses = [
    ...((Array.isArray(routeWarrant?.direct_data_witnesses) ? routeWarrant.direct_data_witnesses : []) as unknown[]),
    ...((Array.isArray(routeWarrant?.active_tca_witnesses) ? routeWarrant.active_tca_witnesses : []) as unknown[]),
    ...((Array.isArray(routeWarrant?.empirical_replay_witnesses)
      ? routeWarrant.empirical_replay_witnesses
      : []) as unknown[]),
    ...((Array.isArray(routeWarrant?.market_context_witnesses)
      ? routeWarrant.market_context_witnesses
      : []) as unknown[]),
    ...((Array.isArray(routeWarrant?.ingestion_materialization_witnesses)
      ? routeWarrant.ingestion_materialization_witnesses
      : []) as unknown[]),
  ]
    .map((witness) => asRecord(witness))
    .filter((witness): witness is Record<string, unknown> => Boolean(witness))
  const staleWitnesses = routeWarrantWitnesses.filter((witness) => {
    const state = normalizeReason(
      witness.observed_state ?? witness.state ?? witness.status ?? witness.freshness_state ?? witness.verdict,
    )
    return Boolean(state && !['accepted', 'current', 'fresh', 'healthy', 'ok', 'pass', 'ready'].includes(state))
  })
  const routeWarrantRepairPacketIds = uniqueStrings(
    routeWarrantRepairPackets.map((packet) => normalizeNonEmpty(packet.packet_id ?? packet.repair_packet_id)),
  )
  const routeWarrantRepairTargetValueGates = uniqueStrings(
    routeWarrantRepairPackets.map((packet) => normalizeReason(packet.target_value_gate)),
  )
  const routeWarrantBlockingDependencies = uniqueStrings([
    ...stringList(routeWarrant?.blocking_dependency_names),
    ...routeWarrantRepairPackets.map((packet) => normalizeReason(packet.target_dependency)),
    ...staleWitnesses.map((witness) =>
      normalizeReason(
        witness.target_dependency ?? witness.dependency ?? witness.dependency_name ?? witness.name ?? witness.source,
      ),
    ),
  ])
  const routeWarrantBlockingReasonCodes = uniqueStrings([
    ...stringList(routeWarrant?.blocking_reason_codes),
    ...routeWarrantRepairPackets.flatMap((packet) => stringList(packet.blocking_reason_codes)),
    ...staleWitnesses.flatMap((witness) => [
      ...stringList(witness.reason_codes),
      ...stringList(witness.contradiction_reason_codes),
    ]),
  ])
  const repairBidSettlementSchema = normalizeNonEmpty(repairBidSettlement?.schema_version)
  const repairBidSettlementLedgerId = normalizeNonEmpty(repairBidSettlement?.ledger_id)
  const repairBidSettlementFreshUntil = normalizeNonEmpty(repairBidSettlement?.fresh_until)
  const repairBidSettlementFreshUntilMs = parseTimestampMs(repairBidSettlementFreshUntil)
  const repairBidSettlementLots = Array.isArray(repairBidSettlement?.compacted_lots)
    ? repairBidSettlement.compacted_lots
        .map((lot) => normalizeRepairBidSettlementLot(lot))
        .filter((lot): lot is TorghutRepairBidSettlementLot => Boolean(lot))
    : []
  const repairBidSettlementStatus: TorghutRepairBidSettlementStatus = !repairBidSettlement
    ? 'missing'
    : repairBidSettlementSchema !== REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION
      ? 'schema_mismatch'
      : !repairBidSettlementLedgerId || !repairBidSettlementFreshUntil
        ? 'malformed'
        : repairBidSettlementFreshUntilMs && repairBidSettlementFreshUntilMs > now.getTime()
          ? 'current'
          : 'stale'
  const repairBidSettlementReasonCodes = uniqueStrings([
    ...(repairBidSettlementStatus === 'current' ? [] : [`repair_bid_settlement_${repairBidSettlementStatus}`]),
    ...stringList(repairBidSettlement?.raw_reason_codes_preserved),
    ...repairBidSettlementLots.flatMap((lot) => [...lot.raw_reason_codes, ...lot.hold_reason_codes]),
  ])
  const operatorSummary = evidenceClockArbiter
    ? {
        top_clock_split: normalizeNonEmpty(topClockSplit?.clock),
        selected_repair_lot_id: normalizeNonEmpty(selectedEvidenceClockRepair?.lot_id),
        expected_value_gate: normalizeNonEmpty(selectedEvidenceClockRepair?.target_value_gate),
        next_validation_command: `curl -fsS ${endpoint} | jq '.evidence_clock_arbiter.summary'`,
      }
    : null

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
      revenue_repair_business_state: revenueRepairBusinessState,
      revenue_repair_ready: revenueRepairReady,
      revenue_repair_queue: revenueRepairQueue,
      route_canary_id: normalizeNonEmpty(receipt.route_canary_id),
      jangar_parity_escrow_ref: normalizeNonEmpty(receipt.jangar_parity_escrow_ref),
      serving_revision: servingRevision,
      image_digest: normalizeNonEmpty(receipt.image_digest),
      build_commit: buildCommit,
      build_version: buildVersion,
      serving_image_digest: servingImageDigest,
      observed_contracts: observedContracts,
      contract_schema_mismatches: contractSchemaMismatches,
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
      evidence_clock_arbiter_id: evidenceClockArbiterId,
      evidence_clock_state: evidenceClockState,
      evidence_clock_split_clock_names: evidenceClockSplitClockNames,
      evidence_clock_blocking_reason_codes: evidenceClockReasonCodes,
      evidence_clock_custody_status: evidenceClockCustodyStatus,
      evidence_clock_custody_ref: custodyRefId,
      routeable_profit_candidate_exchange_id: routeableExchangeId,
      routeable_exchange_routeable_candidate_count: routeableExchangeRouteableCandidateCount,
      routeable_exchange_zero_notional_repair_lot_ids: routeableExchangeZeroNotionalRepairLotIds,
      routeable_exchange_rejected_candidate_count: routeableExchangeRejectedCandidateCount,
      route_warrant_id: routeWarrantId,
      route_warrant_state: normalizeReason(
        routeWarrant?.warrant_state ?? routeWarrant?.state ?? routeWarrant?.decision,
      ),
      route_warrant_fresh_until: normalizeNonEmpty(routeWarrant?.fresh_until),
      route_warrant_repair_packet_ids: routeWarrantRepairPacketIds,
      route_warrant_repair_target_value_gates: routeWarrantRepairTargetValueGates,
      route_warrant_blocking_dependency_names: routeWarrantBlockingDependencies,
      route_warrant_blocking_reason_codes: routeWarrantBlockingReasonCodes,
      route_warrant_zero_notional_or_stale_evidence_rate: normalizeNumber(
        routeWarrant?.zero_notional_or_stale_evidence_rate,
      ),
      route_warrant_fill_tca_or_slippage_quality: normalizeReason(routeWarrant?.fill_tca_or_slippage_quality),
      route_warrant_capital_gate_safety: normalizeReason(routeWarrant?.capital_gate_safety),
      route_warrant_post_cost_daily_net_pnl_state: normalizeReason(routeWarrant?.post_cost_daily_net_pnl_state),
      repair_bid_settlement_ledger_id: repairBidSettlementLedgerId,
      repair_bid_settlement_status: repairBidSettlementStatus,
      repair_bid_settlement_generated_at: normalizeNonEmpty(repairBidSettlement?.generated_at),
      repair_bid_settlement_fresh_until: repairBidSettlementFreshUntil,
      repair_bid_settlement_capital_decision: normalizeReason(repairBidSettlement?.capital_decision),
      repair_bid_settlement_max_notional: normalizeNonEmpty(repairBidSettlement?.max_notional),
      repair_bid_settlement_routeable_candidate_count: normalizeNumber(repairBidSettlement?.routeable_candidate_count),
      repair_bid_settlement_selected_lot_ids: stringValues(repairBidSettlement?.selected_lot_ids),
      repair_bid_settlement_dispatchable_lot_ids: stringValues(repairBidSettlement?.dispatchable_lot_ids),
      repair_bid_settlement_held_lot_ids: stringValues(repairBidSettlement?.held_lot_ids),
      repair_bid_settlement_active_dedupe_keys: stringValues(repairBidSettlement?.active_dedupe_keys),
      repair_bid_settlement_compacted_lots: repairBidSettlementLots,
      repair_bid_settlement_reason_codes: repairBidSettlementReasonCodes,
      alpha_readiness_strike_ledger: alphaReadinessStrikeLedger,
      executable_alpha_repair_receipts: executableAlphaRepairReceipts,
      alpha_repair_closure_board: alphaRepairClosureBoard,
      alpha_evidence_foundry: alphaEvidenceFoundry,
      alpha_readiness_settlement_conveyor: alphaReadinessSettlementConveyor,
      alpha_repair_dividend_ledger: alphaRepairDividendLedger,
      alpha_closure_dividend_slo: alphaClosureDividendSlo,
      no_delta_repair_reentry_auction: noDeltaRepairReentryAuction,
      repair_outcome_dividend_ledger_id: repairOutcome.ledgerId,
      repair_outcome_receipt_ids: repairOutcome.receiptIds,
      repair_outcome_open_escrow_ids: repairOutcome.openEscrowIds,
      repair_outcome_no_delta_lot_ids: repairOutcome.noDeltaLotIds,
      repair_outcome_retired_reason_codes: repairOutcome.retiredReasonCodes,
      repair_outcome_preserved_reason_codes: repairOutcome.preservedReasonCodes,
      repair_outcome_escrows: repairOutcome.escrows,
      freshness_carry_ledger_id: freshnessCarry.ledgerId,
      freshness_carry_state: freshnessCarry.state,
      freshness_carry_pressure_ref_ids: freshnessCarry.pressureRefIds,
      freshness_carry_dispatchable_pressure_ref_ids: freshnessCarry.dispatchablePressureRefIds,
      freshness_carry_required_output_receipts: freshnessCarry.requiredOutputReceipts,
      freshness_carry_target_value_gates: freshnessCarry.targetValueGates,
      freshness_carry_reason_codes: freshnessCarry.reasonCodes,
      operator_summary: operatorSummary,
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
      evidence_clock_arbiter_id: evidenceClockArbiterId,
      evidence_clock_status: evidenceClockState,
      evidence_clock_split_clock_names: evidenceClockSplitClockNames,
      evidence_clock_blocking_reason_codes: evidenceClockReasonCodes,
      evidence_clock_custody_status: evidenceClockCustodyStatus,
      evidence_clock_custody_ref: custodyRefId,
      evidence_clock_custody_reason_codes: evidenceClockCustodyReasonCodes,
      routeable_profit_candidate_exchange_id: routeableExchangeId,
      routeable_exchange_zero_notional_repair_lot_ids: routeableExchangeZeroNotionalRepairLotIds,
      routeable_exchange_routeable_candidate_count: routeableExchangeRouteableCandidateCount,
      routeable_exchange_rejected_candidate_count: routeableExchangeRejectedCandidateCount,
      route_warrant_id: routeWarrantId,
      route_warrant_state: normalizeReason(
        routeWarrant?.warrant_state ?? routeWarrant?.state ?? routeWarrant?.decision,
      ),
      route_warrant_repair_packet_ids: routeWarrantRepairPacketIds,
      route_warrant_blocking_dependency_names: routeWarrantBlockingDependencies,
      route_warrant_blocking_reason_codes: routeWarrantBlockingReasonCodes,
      repair_bid_settlement_ledger_id: repairBidSettlementLedgerId,
      repair_bid_settlement_status: repairBidSettlementStatus,
      repair_bid_settlement_selected_lot_ids: stringValues(repairBidSettlement?.selected_lot_ids),
      repair_bid_settlement_dispatchable_lot_ids: stringValues(repairBidSettlement?.dispatchable_lot_ids),
      repair_bid_settlement_held_lot_ids: stringValues(repairBidSettlement?.held_lot_ids),
      repair_bid_settlement_blocking_reason_codes: repairBidSettlementReasonCodes,
    },
  }
}
