import type { TorghutRevenueRepairQueueItem } from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringValues,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts'

export const normalizeRevenueRepairBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  const normalized = normalizeReason(value)
  if (!normalized) return null
  if (['1', 'true', 'yes', 'ready', 'allow'].includes(normalized)) return true
  if (['0', 'false', 'no', 'blocked', 'hold', 'repair_only'].includes(normalized)) return false
  return null
}

export const hasRevenueRepairSummary = (payload: Record<string, unknown>) =>
  normalizeNonEmpty(payload.business_state) !== null ||
  normalizeRevenueRepairBoolean(payload.revenue_ready) !== null ||
  Array.isArray(payload.repair_queue)

const readRevenueRepairQueueItem = (rawItem: unknown): TorghutRevenueRepairQueueItem | null => {
  const item = asRecord(rawItem)
  if (!item) return null
  const code = normalizeReason(item.code)
  const reason = normalizeReason(item.reason)
  const valueGate = normalizeReason(item.value_gate)
  if (!code && !reason && !valueGate) return null
  return {
    code,
    reason,
    dimension: normalizeReason(item.dimension),
    action: normalizeReason(item.action),
    priority: normalizeNumber(item.priority),
    expected_unblock_value: normalizeNumber(item.expected_unblock_value),
    source: normalizeReason(item.source),
    value_gate: valueGate,
    required_output_receipt: normalizeNonEmpty(item.required_output_receipt),
    required_receipts: stringValues(item.required_receipts),
    max_notional: normalizeNonEmpty(item.max_notional),
    capital_rule: normalizeReason(item.capital_rule),
    observed_count: normalizeNumber(item.observed_count),
  }
}

export const readRevenueRepairQueue = (payload: Record<string, unknown> | null): TorghutRevenueRepairQueueItem[] => {
  if (!payload) return []
  const repairQueue = Array.isArray(payload.repair_queue)
    ? payload.repair_queue
        .map(readRevenueRepairQueueItem)
        .filter((item): item is TorghutRevenueRepairQueueItem => Boolean(item))
    : []
  if (repairQueue.length > 0) return repairQueue
  const topItem = readRevenueRepairQueueItem(payload.top_repair_queue_item)
  return topItem ? [topItem] : []
}
