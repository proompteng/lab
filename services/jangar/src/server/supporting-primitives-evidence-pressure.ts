import {
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_DECISION,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_FRESH_UNTIL,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_LEDGER_ID,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_MODE,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_REASON_CODES,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_REQUIRED_REPAIR_RECEIPTS,
  SWARM_EVIDENCE_PRESSURE_ANNOTATION_WATCH_BACKOFF_STATE,
} from '@proompteng/agent-contracts/swarm-contracts'

import type { ActionSloBudgetActionClass, EvidencePressureDecision } from '~/server/control-plane-status-types'
import { asRecord, asString } from '~/server/primitives-http'

export type EvidencePressureTrace = {
  ledgerId: string
  decision: EvidencePressureDecision | null
  mode: string | null
  freshUntil: string | null
  reasonCodes: string[]
  requiredRepairReceipts: string[]
  watchBackoffState: string | null
}

export type EvidencePressureBudgetSnapshot = {
  actionClass: ActionSloBudgetActionClass
  decision: EvidencePressureDecision | null
  reasonCodes: string[]
  requiredRepairReceipts: string[]
}

export type EvidencePressureStatusSnapshot = {
  ledgerId: string
  evidenceMode: string | null
  freshUntil: string | null
  watchBackoffState: string | null
  budgets: EvidencePressureBudgetSnapshot[]
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const isPresent = <T>(value: T | null | undefined): value is T => value != null

const compactStrings = (values: unknown[]) => values.map(asString).filter(isPresent)

const parseEvidencePressureDecision = (value: unknown): EvidencePressureDecision | null => {
  const normalized = asString(value)
  if (normalized === 'allow' || normalized === 'repair_only' || normalized === 'hold' || normalized === 'block') {
    return normalized
  }
  return null
}

const readEvidencePressureBudgetSnapshot = (value: unknown): EvidencePressureBudgetSnapshot | null => {
  const record = asRecord(value)
  if (!record) return null
  const actionClass = asString(record.action_class)
  if (!actionClass) return null

  return {
    actionClass: actionClass as ActionSloBudgetActionClass,
    decision: parseEvidencePressureDecision(record.decision),
    reasonCodes: compactStrings(asArray(record.reason_codes)),
    requiredRepairReceipts: compactStrings(asArray(record.required_repair_receipts)),
  }
}

export const readEvidencePressureStatusSnapshot = (value: unknown): EvidencePressureStatusSnapshot | null => {
  const record = asRecord(value)
  if (!record) return null
  const ledgerId = asString(record.ledger_id)
  if (!ledgerId) return null
  const watchBackoff = asRecord(record.watch_backoff_policy)

  return {
    ledgerId,
    evidenceMode: asString(record.evidence_mode),
    freshUntil: asString(record.fresh_until),
    watchBackoffState: asString(watchBackoff?.state),
    budgets: asArray(record.action_pressure_budget).map(readEvidencePressureBudgetSnapshot).filter(isPresent),
  }
}

export const evidencePressureTraceForAction = (
  snapshot: { evidencePressure?: EvidencePressureStatusSnapshot | null } | null | undefined,
  actionClass: ActionSloBudgetActionClass,
): EvidencePressureTrace | null => {
  const ledger = snapshot?.evidencePressure
  if (!ledger) return null
  const budget = ledger.budgets.find((entry) => entry.actionClass === actionClass) ?? null

  return {
    ledgerId: ledger.ledgerId,
    decision: budget?.decision ?? null,
    mode: ledger.evidenceMode,
    freshUntil: ledger.freshUntil,
    reasonCodes: budget?.reasonCodes ?? [],
    requiredRepairReceipts: budget?.requiredRepairReceipts ?? [],
    watchBackoffState: ledger.watchBackoffState,
  }
}

export const evidencePressureEnforced = (trace: EvidencePressureTrace | null) =>
  trace?.mode === 'hold' || trace?.mode === 'enforce'

export const applyEvidencePressureTrace = (
  annotations: Record<string, string>,
  parameters: Record<string, string>,
  evidencePressure: EvidencePressureTrace | null,
) => {
  if (!evidencePressure) return
  annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_LEDGER_ID] = evidencePressure.ledgerId
  parameters.swarmEvidencePressureLedgerId = evidencePressure.ledgerId

  if (evidencePressure.decision) {
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_DECISION] = evidencePressure.decision
    parameters.swarmEvidencePressureDecision = evidencePressure.decision
  }
  if (evidencePressure.mode) {
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_MODE] = evidencePressure.mode
    parameters.swarmEvidencePressureMode = evidencePressure.mode
  }
  if (evidencePressure.freshUntil) {
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_FRESH_UNTIL] = evidencePressure.freshUntil
    parameters.swarmEvidencePressureFreshUntil = evidencePressure.freshUntil
  }
  if (evidencePressure.reasonCodes.length > 0) {
    const reasonCodes = evidencePressure.reasonCodes.join(',')
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_REASON_CODES] = reasonCodes
    parameters.swarmEvidencePressureReasonCodes = reasonCodes
  }
  if (evidencePressure.watchBackoffState) {
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_WATCH_BACKOFF_STATE] = evidencePressure.watchBackoffState
    parameters.swarmEvidencePressureWatchBackoffState = evidencePressure.watchBackoffState
  }
  if (evidencePressure.requiredRepairReceipts.length > 0) {
    const requiredRepairReceipts = evidencePressure.requiredRepairReceipts.join(',')
    annotations[SWARM_EVIDENCE_PRESSURE_ANNOTATION_REQUIRED_REPAIR_RECEIPTS] = requiredRepairReceipts
    parameters.swarmEvidencePressureRequiredRepairReceipts = requiredRepairReceipts
  }
}
