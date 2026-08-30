export const SWARM_STAGE_NAMES = ['discover', 'plan', 'implement', 'verify'] as const
export type SwarmStageName = (typeof SWARM_STAGE_NAMES)[number]
export type SwarmStageTargetRef = { kind: 'AgentRun' | 'OrchestrationRun'; name: string; namespace: string }

export const SWARM_STAGE_CADENCE_KEY: Record<SwarmStageName, string> = {
  discover: 'discoverEvery',
  plan: 'planEvery',
  implement: 'implementEvery',
  verify: 'verifyEvery',
}

export const SWARM_STAGE_LAST_RUN_KEY: Record<SwarmStageName, string> = {
  discover: 'lastDiscoverAt',
  plan: 'lastPlanAt',
  implement: 'lastImplementAt',
  verify: 'lastVerifyAt',
}

export const SWARM_NAME_LABEL = 'swarm.proompteng.ai/name'
export const SWARM_STAGE_LABEL = 'swarm.proompteng.ai/stage'
export const SWARM_REQUIREMENT_LABEL_TYPE = 'swarm.proompteng.ai/type'
export const SWARM_REQUIREMENT_LABEL_TO = 'swarm.proompteng.ai/to'
export const SWARM_REQUIREMENT_LABEL_FROM = 'swarm.proompteng.ai/from'
export const SWARM_REQUIREMENT_LABEL_ID = 'swarm.proompteng.ai/requirement-id'
export const SWARM_REQUIREMENT_LABEL_ATTEMPT = 'swarm.proompteng.ai/requirement-attempt'
export const SWARM_REQUIREMENT_LABEL_CHANNEL = 'swarm.proompteng.ai/requirement-channel'
export const SWARM_REQUIREMENT_ANNOTATION_SIGNAL = 'swarm.proompteng.ai/requirement-signal'
export const SWARM_AGENT_WORKER_ID_LABEL = 'swarm.proompteng.ai/worker-id'

export const SWARM_SCHEDULE_ANNOTATION_WORKER_ID = 'swarm.proompteng.ai/worker-id'
export const SWARM_SCHEDULE_ANNOTATION_IDENTITY = 'swarm.proompteng.ai/agent-identity'
export const SWARM_SCHEDULE_ANNOTATION_ROLE = 'swarm.proompteng.ai/agent-role'
export const SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL = 'swarm.proompteng.ai/owner-channel'
export const SWARM_SCHEDULE_ANNOTATION_NATS_URL = 'swarm.proompteng.ai/nats-url'
export const SWARM_SCHEDULE_ANNOTATION_NATS_SUBJECT_PREFIX = 'swarm.proompteng.ai/nats-subject-prefix'
export const SWARM_SCHEDULE_ANNOTATION_NATS_CHANNEL = 'swarm.proompteng.ai/nats-channel'
export const SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME = 'swarm.proompteng.ai/human-name'

export const SWARM_MISSION_ANNOTATION_LEDGER_REF = 'swarm.proompteng.ai/mission-ledger-ref'
export const SWARM_MISSION_ANNOTATION_BUSINESS_METRIC = 'swarm.proompteng.ai/business-metric'
export const SWARM_MISSION_ANNOTATION_VALIDATION_CONTRACT = 'swarm.proompteng.ai/validation-contract'
export const SWARM_MISSION_ANNOTATION_VALUE_GATES = 'swarm.proompteng.ai/value-gates'
export const SWARM_MISSION_ANNOTATION_HANDOFF_FIELDS = 'swarm.proompteng.ai/handoff-fields'
export const SWARM_MISSION_ANNOTATION_SOURCE_DESIGN = 'swarm.proompteng.ai/source-design'

export const SWARM_ADMISSION_ANNOTATION_RUNTIME_ADMISSION_DESIGN_REF =
  'swarm.proompteng.ai/runtime-admission-design-ref'
export const SWARM_ADMISSION_ANNOTATION_RUNTIME_PROOF_DESIGN_REF = 'swarm.proompteng.ai/runtime-proof-design-ref'
export const SWARM_ADMISSION_ANNOTATION_PASSPORT_ID = 'swarm.proompteng.ai/admission-passport-id'
export const SWARM_ADMISSION_ANNOTATION_DECISION = 'swarm.proompteng.ai/admission-decision'
export const SWARM_ADMISSION_ANNOTATION_RECOVERY_DIGEST = 'swarm.proompteng.ai/recovery-case-set-digest'
export const SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST = 'swarm.proompteng.ai/runtime-kit-set-digest'
export const SWARM_ADMISSION_ANNOTATION_RUNTIME_KITS = 'swarm.proompteng.ai/required-runtime-kits'
export const SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION = 'swarm.proompteng.ai/admission-producer-revision'
export const SWARM_ADMISSION_ANNOTATION_WARRANT_ID = 'swarm.proompteng.ai/recovery-warrant-id'
export const SWARM_ADMISSION_ANNOTATION_WARRANT_STATUS = 'swarm.proompteng.ai/recovery-warrant-status'
export const SWARM_ADMISSION_ANNOTATION_PROOF_CELLS = 'swarm.proompteng.ai/required-proof-cells'

export const SWARM_STAGE_CLEARANCE_ANNOTATION_PACKET_ID = 'swarm.proompteng.ai/stage-clearance-packet-id'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_DECISION = 'swarm.proompteng.ai/stage-clearance-decision'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS = 'swarm.proompteng.ai/stage-clearance-action-class'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_FRESH_UNTIL = 'swarm.proompteng.ai/stage-clearance-fresh-until'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_REASON_CODES = 'swarm.proompteng.ai/stage-clearance-reason-codes'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_MODE = 'swarm.proompteng.ai/stage-clearance-mode'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_REQUIRED_REPAIR_ACTION =
  'swarm.proompteng.ai/stage-clearance-required-repair-action'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_ID = 'swarm.proompteng.ai/dependency-verdict-id'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_DECISION =
  'swarm.proompteng.ai/dependency-verdict-decision'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_LEDGER_ID =
  'swarm.proompteng.ai/clearance-market-ledger-id'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_ADMISSION_ID =
  'swarm.proompteng.ai/clearance-market-stage-admission-id'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_DECISION =
  'swarm.proompteng.ai/clearance-market-stage-decision'
export const SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_SELECTED_REPAIR_LOT =
  'swarm.proompteng.ai/clearance-market-selected-repair-lot'

export const SWARM_STAGE_CREDIT_ANNOTATION_LEDGER_ID = 'swarm.proompteng.ai/stage-credit-ledger-id'
export const SWARM_STAGE_CREDIT_ANNOTATION_ACCOUNT_ID = 'swarm.proompteng.ai/stage-credit-account-id'
export const SWARM_STAGE_CREDIT_ANNOTATION_ACTION_CLASS = 'swarm.proompteng.ai/stage-credit-action-class'
export const SWARM_STAGE_CREDIT_ANNOTATION_DECISION = 'swarm.proompteng.ai/stage-credit-decision'
export const SWARM_STAGE_CREDIT_ANNOTATION_MODE = 'swarm.proompteng.ai/stage-credit-mode'
export const SWARM_STAGE_CREDIT_ANNOTATION_FRESH_UNTIL = 'swarm.proompteng.ai/stage-credit-fresh-until'
export const SWARM_STAGE_CREDIT_ANNOTATION_REASON_CODES = 'swarm.proompteng.ai/stage-credit-reason-codes'
export const SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_ID = 'swarm.proompteng.ai/runner-slot-future-id'
export const SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_EXPIRES_AT =
  'swarm.proompteng.ai/runner-slot-future-expires-at'
export const SWARM_STAGE_CREDIT_ANNOTATION_SELECTED_REPAIR_LOT = 'swarm.proompteng.ai/stage-credit-selected-repair-lot'

export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_LEDGER_ID = 'swarm.proompteng.ai/evidence-pressure-ledger-id'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_DECISION = 'swarm.proompteng.ai/evidence-pressure-decision'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_MODE = 'swarm.proompteng.ai/evidence-pressure-mode'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_FRESH_UNTIL = 'swarm.proompteng.ai/evidence-pressure-fresh-until'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_REASON_CODES = 'swarm.proompteng.ai/evidence-pressure-reason-codes'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_WATCH_BACKOFF_STATE =
  'swarm.proompteng.ai/evidence-pressure-watch-backoff-state'
export const SWARM_EVIDENCE_PRESSURE_ANNOTATION_REQUIRED_REPAIR_RECEIPTS =
  'swarm.proompteng.ai/evidence-pressure-required-repair-receipts'

export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_SETTLEMENT_ID = 'swarm.proompteng.ai/material-evidence-settlement-id'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_DECISION = 'swarm.proompteng.ai/material-evidence-decision'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_MODE = 'swarm.proompteng.ai/material-evidence-mode'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_FRESH_UNTIL = 'swarm.proompteng.ai/material-evidence-fresh-until'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_REASON_CODES = 'swarm.proompteng.ai/material-evidence-reason-codes'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_REPAIR_TICKET_CLASS =
  'swarm.proompteng.ai/material-evidence-repair-ticket-class'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_TICKET =
  'swarm.proompteng.ai/material-evidence-selected-ticket'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_SELECTED_VALUE_GATE =
  'swarm.proompteng.ai/material-evidence-selected-value-gate'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_BUSINESS_STATE = 'swarm.proompteng.ai/material-evidence-business-state'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_MAX_NOTIONAL = 'swarm.proompteng.ai/material-evidence-max-notional'
export const SWARM_MATERIAL_EVIDENCE_ANNOTATION_DESIGN_REFS = 'swarm.proompteng.ai/material-evidence-design-refs'
