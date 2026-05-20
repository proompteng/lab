import type { TorghutNoDeltaRepairReentryAuctionRef } from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts/json'

export const NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION = 'torghut.no-delta-repair-reentry-auction-ref.v1'

export const readNoDeltaRepairReentryAuctionRef = (
  payload: Record<string, unknown> | null,
): TorghutNoDeltaRepairReentryAuctionRef | null => {
  const auction = asRecord(payload?.no_delta_repair_reentry_auction)
  if (!auction) return null
  const schema = normalizeNonEmpty(auction.schema_version)
  if (schema !== NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION) return null

  return {
    schema_version: NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION,
    auction_schema_version: normalizeNonEmpty(auction.auction_schema_version),
    auction_id: normalizeNonEmpty(auction.auction_id),
    generated_at: normalizeNonEmpty(auction.generated_at),
    fresh_until: normalizeNonEmpty(auction.fresh_until),
    reentry_decision: normalizeReason(auction.reentry_decision),
    reason_codes: stringList(auction.reason_codes),
    active_no_delta_release_key: normalizeNonEmpty(auction.active_no_delta_release_key),
    selected_hypothesis_id: normalizeNonEmpty(auction.selected_hypothesis_id),
    selected_value_gate: normalizeReason(auction.selected_value_gate),
    routeable_candidate_count_before: normalizeNumber(auction.routeable_candidate_count_before),
    routeable_candidate_count_after: normalizeNumber(auction.routeable_candidate_count_after),
    selected_ticket_id: normalizeNonEmpty(auction.selected_ticket_id),
    selected_ticket_class: normalizeReason(auction.selected_ticket_class),
    selected_release_condition: normalizeReason(auction.selected_release_condition),
    required_output_receipt: normalizeNonEmpty(auction.required_output_receipt),
    validation_command: normalizeNonEmpty(auction.validation_command),
    enforcement_mode: normalizeReason(auction.enforcement_mode),
    max_notional: normalizeNonEmpty(auction.max_notional),
    capital_rule: normalizeReason(auction.capital_rule),
    rollback_target: normalizeNonEmpty(auction.rollback_target),
  }
}

export const noDeltaRepairReentryAuctionRefSchemaMismatch = (
  payload: Record<string, unknown> | null,
): string | null => {
  const auction = asRecord(payload?.no_delta_repair_reentry_auction)
  if (!auction) return null
  const schema = normalizeNonEmpty(auction.schema_version)
  if (!schema || schema === NO_DELTA_REPAIR_REENTRY_AUCTION_REF_SCHEMA_VERSION) return null
  return `no_delta_repair_reentry_auction:${schema}`
}
