import type {
  MaterialEvidenceRepairTicketClass,
  MaterialEvidenceSettlementDecision,
  MaterialEvidenceSettlementMode,
} from '~/data/agents-control-plane'
import { asRecord, asString } from '~/server/primitives-http'
import {
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_BUSINESS_STATE,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_DECISION,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_DESIGN_REFS,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_FRESH_UNTIL,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_MAX_NOTIONAL,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_MODE,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_REASON_CODES,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_REPAIR_TICKET_CLASS,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_TICKET,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_VALUE_GATE,
  SWARM_MATERIAL_EVIDENCE_ANNOTATION_SETTLEMENT_ID,
} from '~/server/supporting-primitives-schedule-runner'

export type MaterialEvidenceSettlementTrace = {
  settlementId: string
  decision: MaterialEvidenceSettlementDecision | null
  mode: MaterialEvidenceSettlementMode | null
  freshUntil: string | null
  reasonCodes: string[]
  repairTicketClass: MaterialEvidenceRepairTicketClass | null
  selectedTicketRef: string | null
  selectedValueGate: string | null
  businessState: string | null
  maxNotional: string | null
  governingDesignRefs: string[]
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const isPresent = <T>(value: T | null | undefined): value is T => value != null

const compactStrings = (values: unknown[]) => values.map(asString).filter(isPresent)

const parseMaterialEvidenceDecision = (value: unknown): MaterialEvidenceSettlementDecision | null => {
  const decision = asString(value)
  return decision === 'allow' || decision === 'repair_only' || decision === 'hold' || decision === 'block'
    ? decision
    : null
}

const parseMaterialEvidenceMode = (value: unknown): MaterialEvidenceSettlementMode | null => {
  const mode = asString(value)
  return mode === 'observe' || mode === 'shadow' || mode === 'enforce' ? mode : null
}

const parseMaterialEvidenceRepairTicketClass = (value: unknown): MaterialEvidenceRepairTicketClass | null => {
  const ticketClass = asString(value)
  return ticketClass === 'none' ||
    ticketClass === 'controller_ingestion' ||
    ticketClass === 'verification_carry_rollout' ||
    ticketClass === 'alpha_readiness' ||
    ticketClass === 'consumer_evidence_projection_refresh'
    ? ticketClass
    : null
}

export const readMaterialEvidenceSettlementTrace = (value: unknown): MaterialEvidenceSettlementTrace | null => {
  const record = asRecord(value)
  if (!record) return null
  const settlementId = asString(record.settlement_id)
  if (!settlementId) return null

  const budget = asRecord(record.repair_dispatch_budget)
  const businessTruth = asRecord(record.business_truth)
  return {
    settlementId,
    decision: parseMaterialEvidenceDecision(record.decision),
    mode: parseMaterialEvidenceMode(record.mode),
    freshUntil: asString(record.fresh_until),
    reasonCodes: compactStrings(asArray(record.reason_codes)),
    repairTicketClass: parseMaterialEvidenceRepairTicketClass(budget?.ticket_class),
    selectedTicketRef: asString(budget?.selected_ticket_ref),
    selectedValueGate: asString(businessTruth?.selected_value_gate),
    businessState: asString(businessTruth?.business_state),
    maxNotional: asString(businessTruth?.max_notional),
    governingDesignRefs: compactStrings(asArray(record.governing_design_refs)),
  }
}

export const applyMaterialEvidenceTrace = (
  annotations: Record<string, string>,
  parameters: Record<string, string>,
  materialEvidence: MaterialEvidenceSettlementTrace | null,
) => {
  if (materialEvidence) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_SETTLEMENT_ID] = materialEvidence.settlementId
    parameters.swarmMaterialEvidenceSettlementId = materialEvidence.settlementId
  }
  if (materialEvidence?.decision) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_DECISION] = materialEvidence.decision
    parameters.swarmMaterialEvidenceDecision = materialEvidence.decision
  }
  if (materialEvidence?.mode) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_MODE] = materialEvidence.mode
    parameters.swarmMaterialEvidenceMode = materialEvidence.mode
  }
  if (materialEvidence?.freshUntil) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_FRESH_UNTIL] = materialEvidence.freshUntil
    parameters.swarmMaterialEvidenceFreshUntil = materialEvidence.freshUntil
  }
  if (materialEvidence && materialEvidence.reasonCodes.length > 0) {
    const materialEvidenceReasonCodes = materialEvidence.reasonCodes.join(',')
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_REASON_CODES] = materialEvidenceReasonCodes
    parameters.swarmMaterialEvidenceReasonCodes = materialEvidenceReasonCodes
  }
  if (materialEvidence?.repairTicketClass) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_REPAIR_TICKET_CLASS] = materialEvidence.repairTicketClass
    parameters.swarmMaterialEvidenceRepairTicketClass = materialEvidence.repairTicketClass
  }
  if (materialEvidence?.selectedTicketRef) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_TICKET] = materialEvidence.selectedTicketRef
    parameters.swarmMaterialEvidenceSelectedTicketRef = materialEvidence.selectedTicketRef
  }
  if (materialEvidence?.selectedValueGate) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_VALUE_GATE] = materialEvidence.selectedValueGate
    parameters.swarmMaterialEvidenceSelectedValueGate = materialEvidence.selectedValueGate
  }
  if (materialEvidence?.businessState) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_BUSINESS_STATE] = materialEvidence.businessState
    parameters.swarmMaterialEvidenceBusinessState = materialEvidence.businessState
  }
  if (materialEvidence?.maxNotional) {
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_MAX_NOTIONAL] = materialEvidence.maxNotional
    parameters.swarmMaterialEvidenceMaxNotional = materialEvidence.maxNotional
  }
  if (materialEvidence && materialEvidence.governingDesignRefs.length > 0) {
    const materialEvidenceDesignRefs = materialEvidence.governingDesignRefs.join(',')
    annotations[SWARM_MATERIAL_EVIDENCE_ANNOTATION_DESIGN_REFS] = materialEvidenceDesignRefs
    parameters.swarmMaterialEvidenceDesignRefs = materialEvidenceDesignRefs
  }
}

export const materialEvidenceStatusFields = (materialEvidence: MaterialEvidenceSettlementTrace | null) => ({
  materialEvidenceSettlementId: materialEvidence?.settlementId ?? null,
  materialEvidenceDecision: materialEvidence?.decision ?? null,
  materialEvidenceMode: materialEvidence?.mode ?? null,
  materialEvidenceFreshUntil: materialEvidence?.freshUntil ?? null,
  materialEvidenceReasonCodes: materialEvidence?.reasonCodes ?? [],
  materialEvidenceRepairTicketClass: materialEvidence?.repairTicketClass ?? null,
  materialEvidenceSelectedTicketRef: materialEvidence?.selectedTicketRef ?? null,
  materialEvidenceSelectedValueGate: materialEvidence?.selectedValueGate ?? null,
  materialEvidenceBusinessState: materialEvidence?.businessState ?? null,
  materialEvidenceMaxNotional: materialEvidence?.maxNotional ?? null,
})
