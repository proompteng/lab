import type {
  TorghutAlphaReadinessStrikeLedger,
  TorghutAlphaReadinessStrikeSlot,
} from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
  stringValues,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

const ALPHA_READINESS_STRIKE_LEDGER_SCHEMA_VERSION = 'torghut.alpha-readiness-strike-ledger.v1'

export const deriveRevenueRepairEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint)
    if (url.pathname.endsWith('/trading/revenue-repair')) return url.toString().replace(/\/$/, '')
    if (url.pathname.endsWith('/trading/consumer-evidence')) {
      url.pathname = url.pathname.replace(/\/trading\/consumer-evidence$/, '/trading/revenue-repair')
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    return null
  }
  return null
}

const readAlphaStrikeSlot = (rawSlot: unknown): TorghutAlphaReadinessStrikeSlot | null => {
  const slot = asRecord(rawSlot)
  if (!slot) return null
  const slotId = normalizeNonEmpty(slot.slot_id)
  if (!slotId) return null
  return {
    slot_id: slotId,
    lot_id: normalizeNonEmpty(slot.lot_id),
    source_repair_bid_ids: stringValues(slot.source_repair_bid_ids),
    lot_class: normalizeReason(slot.lot_class) ?? '',
    target_value_gate: normalizeReason(slot.target_value_gate) ?? '',
    admission_reason: normalizeReason(slot.admission_reason),
    preempted_lot_class: normalizeReason(slot.preempted_lot_class),
    dedupe_key: normalizeNonEmpty(slot.dedupe_key),
    ttl_seconds: normalizeNumber(slot.ttl_seconds),
    max_runtime_seconds: normalizeNumber(slot.max_runtime_seconds),
    state: normalizeReason(slot.state),
    required_output_receipt: normalizeNonEmpty(slot.required_output_receipt),
    capital_rule: normalizeReason(slot.capital_rule),
    max_notional: normalizeNonEmpty(slot.max_notional),
    hold_reason_codes: stringList(slot.hold_reason_codes),
  }
}

export const readAlphaReadinessStrikeLedger = (
  payload: Record<string, unknown> | null,
): TorghutAlphaReadinessStrikeLedger | null => {
  const ledger = asRecord(payload?.alpha_readiness_strike_ledger)
  if (!ledger) return null
  const schema = normalizeNonEmpty(ledger.schema_version)
  if (schema !== ALPHA_READINESS_STRIKE_LEDGER_SCHEMA_VERSION) return null
  const ledgerId = normalizeNonEmpty(ledger.ledger_id)
  if (!ledgerId) return null
  const blocker = asRecord(ledger.selected_business_blocker)
  const slots = Array.isArray(ledger.strike_slots)
    ? ledger.strike_slots
        .map(readAlphaStrikeSlot)
        .filter((slot): slot is TorghutAlphaReadinessStrikeSlot => Boolean(slot))
    : []
  return {
    schema_version: ALPHA_READINESS_STRIKE_LEDGER_SCHEMA_VERSION,
    ledger_id: ledgerId,
    generated_at: normalizeNonEmpty(ledger.generated_at),
    fresh_until: normalizeNonEmpty(ledger.fresh_until),
    account_id: normalizeNonEmpty(ledger.account_id),
    window: normalizeNonEmpty(ledger.window),
    trading_mode: normalizeReason(ledger.trading_mode),
    capital_stage: normalizeReason(ledger.capital_stage),
    max_notional: normalizeNonEmpty(ledger.max_notional),
    status: normalizeReason(ledger.status),
    revenue_repair_digest_ref: normalizeNonEmpty(ledger.revenue_repair_digest_ref),
    selected_business_blocker: blocker
      ? {
          code: normalizeReason(blocker.code),
          reason: normalizeReason(blocker.reason),
          value_gate: normalizeReason(blocker.value_gate),
          required_output_receipt: normalizeNonEmpty(blocker.required_output_receipt),
        }
      : null,
    routeable_candidate_count_before: normalizeNumber(ledger.routeable_candidate_count_before),
    zero_notional_or_stale_evidence_rate_before: normalizeNumber(ledger.zero_notional_or_stale_evidence_rate_before),
    promotion_custody_lot_ref: normalizeNonEmpty(ledger.promotion_custody_lot_ref),
    strike_slots: slots,
    required_after_receipts: stringValues(ledger.required_after_receipts),
    guarded_action_classes: stringValues(ledger.guarded_action_classes),
    reason_codes: stringList(ledger.reason_codes),
    rollback_target: normalizeNonEmpty(ledger.rollback_target),
  }
}
