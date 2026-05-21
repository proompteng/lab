import {
  normalizeBoolean,
  normalizeNonEmpty,
  normalizeReason,
  stringList,
  stringValues,
  uniqueStrings,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts'

const FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION = 'torghut.freshness-carry-ledger.v1'

export type TorghutFreshnessCarryEvidence = {
  present: boolean
  ledgerId: string | null
  state: string | null
  pressureRefIds: string[]
  dispatchablePressureRefIds: string[]
  requiredOutputReceipts: string[]
  targetValueGates: string[]
  reasonCodes: string[]
  contractSchemaMismatch: string | null
}

const pressureRefId = (pressureRef: Record<string, unknown>) =>
  normalizeNonEmpty(pressureRef.pressure_ref_id ?? pressureRef.ref_id ?? pressureRef.evidence_ref)

export const readTorghutFreshnessCarryEvidence = (payload: Record<string, unknown>): TorghutFreshnessCarryEvidence => {
  const ledger = asRecord(payload.freshness_carry_ledger)
  const schema = normalizeNonEmpty(ledger?.schema_version)
  const capitalPosture = asRecord(ledger?.capital_posture)
  const dimensions = Array.isArray(ledger?.dimensions)
    ? ledger.dimensions
        .map((dimension) => asRecord(dimension))
        .filter((dimension): dimension is Record<string, unknown> => Boolean(dimension))
    : []
  const pressureRefs = Array.isArray(ledger?.jangar_pressure_refs)
    ? ledger.jangar_pressure_refs
        .map((pressureRef) => asRecord(pressureRef))
        .filter((pressureRef): pressureRef is Record<string, unknown> => Boolean(pressureRef))
    : []
  const schemaMismatch =
    ledger && schema && schema !== FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION ? `freshness_carry_ledger:${schema}` : null

  return {
    present: Boolean(ledger),
    ledgerId: normalizeNonEmpty(ledger?.ledger_id),
    state: normalizeReason(capitalPosture?.decision ?? ledger?.state ?? ledger?.status),
    pressureRefIds: uniqueStrings(pressureRefs.map((pressureRef) => pressureRefId(pressureRef))),
    dispatchablePressureRefIds: uniqueStrings(
      pressureRefs
        .filter((pressureRef) => normalizeBoolean(pressureRef.dispatchable))
        .map((pressureRef) => pressureRefId(pressureRef)),
    ),
    requiredOutputReceipts: uniqueStrings([
      ...pressureRefs.flatMap((pressureRef) => stringValues(pressureRef.required_output_receipts)),
      ...pressureRefs.map((pressureRef) => normalizeNonEmpty(pressureRef.required_output_receipt)),
    ]),
    targetValueGates: uniqueStrings(pressureRefs.map((pressureRef) => normalizeReason(pressureRef.target_value_gate))),
    reasonCodes: uniqueStrings([
      schemaMismatch ? `freshness_carry_ledger_schema_mismatch:${schema}` : null,
      ...stringList(capitalPosture?.reason_codes),
      ...dimensions.flatMap((dimension) => stringList(dimension.stale_reason_codes)),
      ...pressureRefs.flatMap((pressureRef) => stringList(pressureRef.reason_codes)),
      ...pressureRefs.flatMap((pressureRef) => stringList(pressureRef.hold_reason_codes)),
    ]),
    contractSchemaMismatch: schemaMismatch,
  }
}
