import { createHash } from 'node:crypto'

import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import type { TorghutNegativeEvidenceInput } from '~/server/control-plane-negative-evidence-router'
import { asRecord } from '~/server/primitives-http'

export type TorghutConsumerEvidenceStatus = {
  status: 'disabled' | 'current' | 'stale' | 'missing' | 'unavailable'
  endpoint: string
  receipt_id: string | null
  generated_at: string | null
  fresh_until: string | null
  candidate_id: string | null
  dataset_snapshot_ref: string | null
  max_notional: string | null
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

const requestJson = async (url: string, timeoutMs: number): Promise<Record<string, unknown> | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as unknown
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    return payload as Record<string, unknown>
  } catch {
    return null
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

  const payload = await requestJson(endpoint, config.torghutStatusTimeoutMs)
  if (!payload) {
    return {
      status: {
        status: 'unavailable',
        endpoint,
        receipt_id: null,
        generated_at: null,
        fresh_until: null,
        candidate_id: null,
        dataset_snapshot_ref: null,
        max_notional: null,
        reason_codes: ['torghut_consumer_evidence_unavailable'],
        message: 'torghut consumer evidence endpoint unavailable',
      },
    }
  }

  const receipt = asRecord(payload.torghut_consumer_evidence_receipt ?? payload.consumer_evidence_receipt)
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
    },
  }
}
