import type {
  ActionSloBudgetActionClass,
  ClearanceMarketDecision,
  ClearanceMarketStageAdmission,
  StageClearanceDecision,
  StageClearancePacket,
} from '~/data/agents-control-plane'
import { asRecord, asString } from '~/server/primitives-http'
import {
  readMaterialReentryRequirementSignals,
  type MaterialReentryRequirementSignal,
} from '~/server/supporting-primitives-material-reentry-requirements'
import { resolveSupportingPrimitivesConfig } from '~/server/supporting-primitives-config'
import {
  applyEvidencePressureTrace,
  evidencePressureEnforced,
  evidencePressureTraceForAction,
  readEvidencePressureStatusSnapshot,
  type EvidencePressureStatusSnapshot,
  type EvidencePressureTrace,
} from '~/server/supporting-primitives-evidence-pressure'
import {
  SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS,
  SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_LEDGER_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_SELECTED_REPAIR_LOT,
  SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_ADMISSION_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_DECISION,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DECISION,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_DECISION,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_FRESH_UNTIL,
  SWARM_STAGE_CLEARANCE_ANNOTATION_MODE,
  SWARM_STAGE_CLEARANCE_ANNOTATION_PACKET_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_REASON_CODES,
  SWARM_STAGE_CLEARANCE_ANNOTATION_REQUIRED_REPAIR_ACTION,
  SWARM_STAGE_CREDIT_ANNOTATION_ACCOUNT_ID,
  SWARM_STAGE_CREDIT_ANNOTATION_DECISION,
  SWARM_STAGE_CREDIT_ANNOTATION_FRESH_UNTIL,
  SWARM_STAGE_CREDIT_ANNOTATION_LEDGER_ID,
  SWARM_STAGE_CREDIT_ANNOTATION_MODE,
  SWARM_STAGE_CREDIT_ANNOTATION_REASON_CODES,
  SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_EXPIRES_AT,
  SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_ID,
  SWARM_STAGE_CREDIT_ANNOTATION_SELECTED_REPAIR_LOT,
} from '~/server/supporting-primitives-schedule-runner'
import type { StageName } from '~/server/supporting-primitives-swarm-config'

export type StageClearanceMode = ReturnType<typeof resolveSupportingPrimitivesConfig>['stageClearanceEnforcement']

export type StageClearanceMarketTrace = {
  ledgerId: string
  stageAdmissionId: string | null
  decision: ClearanceMarketDecision | null
  selectedRepairLotRef: string | null
  reasonCodes: string[]
  evidenceRefs: string[]
}

export type StageCreditTrace = {
  ledgerId: string
  accountId: string | null
  decision: ClearanceMarketDecision | null
  mode: string | null
  freshUntil: string | null
  reasonCodes: string[]
  runnerSlotFutureId: string | null
  runnerSlotFutureExpiresAt: string | null
  selectedRepairLotRef: string | null
}

export type StageClearanceLaunchAdmission = {
  mode: StageClearanceMode
  admitted: boolean
  stage: StageName
  actionClass: ActionSloBudgetActionClass
  packet: StageClearancePacket | null
  clearanceMarket: StageClearanceMarketTrace | null
  stageCredit: StageCreditTrace | null
  evidencePressure: EvidencePressureTrace | null
  reason:
    | 'StageClearanceDisabled'
    | 'StageClearanceAllowed'
    | 'StageClearanceShadow'
    | 'StageClearanceUnavailable'
    | 'StageClearanceMissing'
    | 'StageClearanceStale'
    | 'StageClearanceHeld'
    | 'StageClearanceLaunchBudgetExhausted'
    | 'EvidencePressureHeld'
    | 'EvidencePressureStale'
  message: string
  annotations: Record<string, string>
  parameters: Record<string, string>
}

export type StageClearanceStatusSnapshot = {
  packets: StageClearancePacket[]
  clearanceMarketLedgerId: string | null
  stageAdmissions: ClearanceMarketStageAdmission[]
  stageCredit: StageCreditStatusSnapshot | null
  evidencePressure: EvidencePressureStatusSnapshot | null
  materialReentryRequirementSignals: MaterialReentryRequirementSignal[]
}

type StageCreditAccountSnapshot = {
  accountId: string
  stage: StageClearancePacket['stage']
  actionClass: ActionSloBudgetActionClass
  decision: ClearanceMarketDecision | null
  reasonCodes: string[]
  selectedRepairLotRef: string | null
}

type RunnerSlotFutureSnapshot = {
  futureId: string
  accountId: string
  expiresAt: string | null
  settlementState: string | null
}

type StageCreditStatusSnapshot = {
  ledgerId: string
  evidenceMode: string | null
  freshUntil: string | null
  accounts: StageCreditAccountSnapshot[]
  futures: RunnerSlotFutureSnapshot[]
}

type StageClearanceAdmissionSnapshot = Pick<
  StageClearanceStatusSnapshot,
  'clearanceMarketLedgerId' | 'stageAdmissions'
> &
  Partial<Pick<StageClearanceStatusSnapshot, 'stageCredit' | 'evidencePressure'>>

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const isPresent = <T>(value: T | null | undefined): value is T => value != null

const compactStrings = (values: unknown[]) => values.map(asString).filter(isPresent)

export const normalizeStageClearanceHoldStages = (values: string[]) =>
  new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))

export const effectiveStageClearanceMode = (
  mode: StageClearanceMode,
  holdStages: Set<string>,
  stage: StageName,
): StageClearanceMode => {
  if (mode !== 'hold') return mode
  if (holdStages.size === 0 || holdStages.has(stage)) return 'hold'
  return 'shadow'
}

export const stageClearanceActionClassForStage = (_stage: StageName): ActionSloBudgetActionClass => 'dispatch_normal'

const parseStageClearanceDecision = (value: unknown): StageClearanceDecision | null => {
  const normalized = asString(value)
  if (normalized === 'allow' || normalized === 'repair_only' || normalized === 'hold' || normalized === 'block') {
    return normalized
  }
  return null
}

const parseClearanceMarketDecision = (value: unknown): ClearanceMarketDecision | null => {
  const normalized = asString(value)
  if (normalized === 'allow' || normalized === 'repair_only' || normalized === 'hold' || normalized === 'block') {
    return normalized
  }
  return null
}

const readStageClearancePacket = (value: unknown): StageClearancePacket | null => {
  const record = asRecord(value)
  if (!record) return null
  const packetId = asString(record.packet_id)
  const namespace = asString(record.namespace)
  const swarmName = asString(record.swarm_name)
  const stage = asString(record.stage)
  const actionClass = asString(record.action_class)
  const decision = parseStageClearanceDecision(record.decision)
  const generatedAt = asString(record.generated_at)
  const freshUntil = asString(record.fresh_until)
  if (!packetId || !namespace || !swarmName || !stage || !actionClass || !decision || !generatedAt || !freshUntil) {
    return null
  }

  return {
    schema_version: 'jangar.stage-clearance-packet.v1',
    packet_id: packetId,
    generated_at: generatedAt,
    fresh_until: freshUntil,
    namespace,
    swarm_name: swarmName,
    stage: stage as StageClearancePacket['stage'],
    action_class: actionClass as ActionSloBudgetActionClass,
    governing_requirement_refs: compactStrings(asArray(record.governing_requirement_refs)),
    source_rollout_truth_ref: asString(record.source_rollout_truth_ref) ?? '',
    controller_witness_ref: asString(record.controller_witness_ref) ?? '',
    agentrun_ingestion_ref: asString(record.agentrun_ingestion_ref) ?? '',
    execution_trust_ref: asString(record.execution_trust_ref) ?? '',
    material_action_verdict_ref: asString(record.material_action_verdict_ref) ?? '',
    route_stability_ref: asString(record.route_stability_ref) ?? '',
    torghut_consumer_evidence_ref: asString(record.torghut_consumer_evidence_ref),
    dependency_verdict_ref: asString(record.dependency_verdict_ref),
    dependency_verdict_decision: parseStageClearanceDecision(record.dependency_verdict_decision),
    failure_domain_leases: compactStrings(asArray(record.failure_domain_leases)),
    provider_capacity_ref: asString(record.provider_capacity_ref),
    decision,
    max_launches: typeof record.max_launches === 'number' ? record.max_launches : null,
    max_notional: typeof record.max_notional === 'number' ? record.max_notional : null,
    ttl_seconds: typeof record.ttl_seconds === 'number' ? record.ttl_seconds : 0,
    reason_codes: compactStrings(asArray(record.reason_codes)),
    required_repair_action: asString(record.required_repair_action),
    rollback_target: asString(record.rollback_target) ?? '',
  }
}

const readClearanceMarketStageAdmission = (value: unknown): ClearanceMarketStageAdmission | null => {
  const record = asRecord(value)
  if (!record) return null
  const stage = asString(record.stage)
  const actionClass = asString(record.action_class)
  const decision = parseClearanceMarketDecision(record.decision)
  if (!stage || !actionClass || !decision) return null

  return {
    admission_id: asString(record.admission_id) ?? '',
    stage: stage as ClearanceMarketStageAdmission['stage'],
    action_class: actionClass as ActionSloBudgetActionClass,
    decision,
    packet_ref: asString(record.packet_ref),
    selected_repair_lot_ref: asString(record.selected_repair_lot_ref),
    reason_codes: compactStrings(asArray(record.reason_codes)),
    evidence_refs: compactStrings(asArray(record.evidence_refs)),
  }
}

const readStageCreditAccountSnapshot = (value: unknown): StageCreditAccountSnapshot | null => {
  const record = asRecord(value)
  if (!record) return null
  const accountId = asString(record.account_id)
  const stage = asString(record.stage)
  const actionClass = asString(record.action_class)
  if (!accountId || !stage || !actionClass) return null

  return {
    accountId,
    stage: stage as StageClearancePacket['stage'],
    actionClass: actionClass as ActionSloBudgetActionClass,
    decision: parseClearanceMarketDecision(record.decision),
    reasonCodes: compactStrings(asArray(record.reason_codes)),
    selectedRepairLotRef: asString(record.selected_repair_lot_ref),
  }
}

const readRunnerSlotFutureSnapshot = (value: unknown): RunnerSlotFutureSnapshot | null => {
  const record = asRecord(value)
  if (!record) return null
  const futureId = asString(record.future_id)
  const accountId = asString(record.account_id)
  if (!futureId || !accountId) return null

  return {
    futureId,
    accountId,
    expiresAt: asString(record.expires_at),
    settlementState: asString(record.settlement_state),
  }
}

const readStageCreditStatusSnapshot = (value: unknown): StageCreditStatusSnapshot | null => {
  const record = asRecord(value)
  if (!record) return null
  const ledgerId = asString(record.ledger_id)
  if (!ledgerId) return null

  return {
    ledgerId,
    evidenceMode: asString(record.evidence_mode),
    freshUntil: asString(record.fresh_until),
    accounts: asArray(record.stage_accounts).map(readStageCreditAccountSnapshot).filter(isPresent),
    futures: asArray(record.runner_slot_futures).map(readRunnerSlotFutureSnapshot).filter(isPresent),
  }
}

const readStageClearanceStatusSnapshot = (status: Record<string, unknown>): StageClearanceStatusSnapshot => {
  const clearanceMarketLedger = asRecord(status.clearance_market_ledger)
  return {
    packets: asArray(status.stage_clearance_packets).map(readStageClearancePacket).filter(isPresent),
    clearanceMarketLedgerId: asString(clearanceMarketLedger?.ledger_id),
    stageAdmissions: asArray(clearanceMarketLedger?.stage_admission)
      .map(readClearanceMarketStageAdmission)
      .filter(isPresent),
    stageCredit: readStageCreditStatusSnapshot(status.stage_credit_ledger),
    evidencePressure: readEvidencePressureStatusSnapshot(status.evidence_pressure_ledger),
    materialReentryRequirementSignals: readMaterialReentryRequirementSignals(status),
  }
}

export const fetchStageClearanceStatusSnapshot = async (
  namespace: string,
  config = resolveSupportingPrimitivesConfig(process.env),
) => {
  const url = new URL(config.scheduleRunnerAdmissionStatusUrl)
  url.searchParams.set('namespace', namespace)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.scheduleRunnerAdmissionStatusTimeoutMs)
  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500)
    throw new Error(`stage clearance status check failed: ${response.status} ${body}`)
  }
  const status = asRecord(await response.json())
  if (!status) throw new Error('stage clearance status response was not an object')
  return readStageClearanceStatusSnapshot(status)
}

export const fetchStageClearancePackets = async (
  namespace: string,
  config = resolveSupportingPrimitivesConfig(process.env),
) => (await fetchStageClearanceStatusSnapshot(namespace, config)).packets

const clearanceMarketTraceForPacket = (
  snapshot: Pick<StageClearanceStatusSnapshot, 'clearanceMarketLedgerId' | 'stageAdmissions'> | null | undefined,
  packet: StageClearancePacket,
): StageClearanceMarketTrace | null => {
  if (!snapshot?.clearanceMarketLedgerId) return null
  const stageAdmission =
    snapshot.stageAdmissions.find(
      (entry) =>
        entry.stage === packet.stage &&
        entry.action_class === packet.action_class &&
        (!entry.packet_ref || entry.packet_ref === packet.packet_id),
    ) ??
    snapshot.stageAdmissions.find(
      (entry) => entry.stage === packet.stage && entry.action_class === packet.action_class,
    ) ??
    null

  return {
    ledgerId: snapshot.clearanceMarketLedgerId,
    stageAdmissionId: stageAdmission?.admission_id || null,
    decision: stageAdmission?.decision ?? null,
    selectedRepairLotRef: stageAdmission?.selected_repair_lot_ref ?? null,
    reasonCodes: stageAdmission?.reason_codes ?? [],
    evidenceRefs: stageAdmission?.evidence_refs ?? [],
  }
}

const stageCreditTraceForPacket = (
  snapshot:
    | Pick<StageClearanceStatusSnapshot, 'stageCredit'>
    | { stageCredit?: StageCreditStatusSnapshot | null }
    | null
    | undefined,
  packet: StageClearancePacket,
  nowMs: number,
): StageCreditTrace | null => {
  const ledger = snapshot?.stageCredit
  if (!ledger) return null
  const ledgerFreshUntilMs = Date.parse(ledger.freshUntil ?? '')
  const ledgerCurrent = Number.isFinite(ledgerFreshUntilMs) && ledgerFreshUntilMs > nowMs
  const account =
    ledger.accounts.find((entry) => entry.stage === packet.stage && entry.actionClass === packet.action_class) ?? null
  const future =
    account === null
      ? null
      : (ledger.futures.find((entry) => {
          if (entry.accountId !== account.accountId || entry.settlementState !== 'open') return false
          if (!ledgerCurrent) return false
          const expiresAtMs = Date.parse(entry.expiresAt ?? '')
          return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
        }) ?? null)

  return {
    ledgerId: ledger.ledgerId,
    accountId: account?.accountId ?? null,
    decision: account?.decision ?? null,
    mode: ledger.evidenceMode,
    freshUntil: ledger.freshUntil,
    reasonCodes: account?.reasonCodes ?? [],
    runnerSlotFutureId: future?.futureId ?? null,
    runnerSlotFutureExpiresAt: future?.expiresAt ?? null,
    selectedRepairLotRef: account?.selectedRepairLotRef ?? null,
  }
}

const buildStageClearanceTrace = (
  packet: StageClearancePacket,
  mode: StageClearanceMode,
  clearanceMarket: StageClearanceMarketTrace | null,
  stageCredit: StageCreditTrace | null,
  evidencePressure: EvidencePressureTrace | null,
): Pick<StageClearanceLaunchAdmission, 'annotations' | 'parameters'> => {
  const reasonCodes = packet.reason_codes.join(',')
  const annotations: Record<string, string> = {
    [SWARM_STAGE_CLEARANCE_ANNOTATION_PACKET_ID]: packet.packet_id,
    [SWARM_STAGE_CLEARANCE_ANNOTATION_DECISION]: packet.decision,
    [SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS]: packet.action_class,
    [SWARM_STAGE_CLEARANCE_ANNOTATION_FRESH_UNTIL]: packet.fresh_until,
    [SWARM_STAGE_CLEARANCE_ANNOTATION_REASON_CODES]: reasonCodes,
    [SWARM_STAGE_CLEARANCE_ANNOTATION_MODE]: mode,
  }
  const parameters: Record<string, string> = {
    swarmStageClearancePacketId: packet.packet_id,
    swarmStageClearanceDecision: packet.decision,
    swarmStageClearanceActionClass: packet.action_class,
    swarmStageClearanceFreshUntil: packet.fresh_until,
    swarmStageClearanceReasonCodes: reasonCodes,
    swarmStageClearanceEnforcement: mode,
  }
  if (clearanceMarket) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_LEDGER_ID] = clearanceMarket.ledgerId
    parameters.swarmClearanceMarketLedgerId = clearanceMarket.ledgerId
  }
  if (clearanceMarket?.stageAdmissionId) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_ADMISSION_ID] = clearanceMarket.stageAdmissionId
    parameters.swarmClearanceMarketStageAdmissionId = clearanceMarket.stageAdmissionId
  }
  if (clearanceMarket?.decision) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_STAGE_DECISION] = clearanceMarket.decision
    parameters.swarmClearanceMarketStageDecision = clearanceMarket.decision
  }
  if (clearanceMarket?.selectedRepairLotRef) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_CLEARANCE_MARKET_SELECTED_REPAIR_LOT] =
      clearanceMarket.selectedRepairLotRef
    parameters.swarmClearanceMarketSelectedRepairLotRef = clearanceMarket.selectedRepairLotRef
  }
  if (packet.required_repair_action) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_REQUIRED_REPAIR_ACTION] = packet.required_repair_action
    parameters.swarmStageClearanceRequiredRepairAction = packet.required_repair_action
  }
  if (packet.dependency_verdict_ref) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_ID] = packet.dependency_verdict_ref
    parameters.swarmDependencyVerdictId = packet.dependency_verdict_ref
  }
  if (packet.dependency_verdict_decision) {
    annotations[SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_DECISION] = packet.dependency_verdict_decision
    parameters.swarmDependencyVerdictDecision = packet.dependency_verdict_decision
  }
  if (stageCredit) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_LEDGER_ID] = stageCredit.ledgerId
    parameters.swarmStageCreditLedgerId = stageCredit.ledgerId
  }
  if (stageCredit?.accountId) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_ACCOUNT_ID] = stageCredit.accountId
    parameters.swarmStageCreditAccountId = stageCredit.accountId
  }
  if (stageCredit?.decision) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_DECISION] = stageCredit.decision
    parameters.swarmStageCreditDecision = stageCredit.decision
  }
  if (stageCredit?.mode) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_MODE] = stageCredit.mode
    parameters.swarmStageCreditMode = stageCredit.mode
  }
  if (stageCredit?.freshUntil) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_FRESH_UNTIL] = stageCredit.freshUntil
    parameters.swarmStageCreditFreshUntil = stageCredit.freshUntil
  }
  if (stageCredit && stageCredit.reasonCodes.length > 0) {
    const stageCreditReasonCodes = stageCredit.reasonCodes.join(',')
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_REASON_CODES] = stageCreditReasonCodes
    parameters.swarmStageCreditReasonCodes = stageCreditReasonCodes
  }
  if (stageCredit?.runnerSlotFutureId) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_ID] = stageCredit.runnerSlotFutureId
    parameters.swarmRunnerSlotFutureId = stageCredit.runnerSlotFutureId
  }
  if (stageCredit?.runnerSlotFutureExpiresAt) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_RUNNER_SLOT_FUTURE_EXPIRES_AT] = stageCredit.runnerSlotFutureExpiresAt
    parameters.swarmRunnerSlotFutureExpiresAt = stageCredit.runnerSlotFutureExpiresAt
  }
  if (stageCredit?.selectedRepairLotRef) {
    annotations[SWARM_STAGE_CREDIT_ANNOTATION_SELECTED_REPAIR_LOT] = stageCredit.selectedRepairLotRef
    parameters.swarmCreditSelectedRepairLotRef = stageCredit.selectedRepairLotRef
  }
  applyEvidencePressureTrace(annotations, parameters, evidencePressure)
  return { annotations, parameters }
}

const summarizeStageClearanceBlock = (
  packet: StageClearancePacket,
  clearanceMarket: StageClearanceMarketTrace | null,
) => {
  const reasons = packet.reason_codes.length > 0 ? `: ${packet.reason_codes.join(', ')}` : ''
  const repair = packet.required_repair_action ? `; required repair: ${packet.required_repair_action}` : ''
  const ledger = clearanceMarket ? `; clearance ledger: ${clearanceMarket.ledgerId}` : ''
  const lot = clearanceMarket?.selectedRepairLotRef
    ? `; selected repair lot: ${clearanceMarket.selectedRepairLotRef}`
    : ''
  return `stage clearance packet ${packet.packet_id} is ${packet.decision}${reasons}${repair}${ledger}${lot}`
}

export const resolveStageClearanceAdmissionFromPackets = (input: {
  namespace: string
  swarmName: string
  stage: StageName
  mode: StageClearanceMode
  packets: StageClearancePacket[]
  clearanceMarket?: StageClearanceAdmissionSnapshot | null
  nowMs?: number
}): StageClearanceLaunchAdmission => {
  const actionClass = stageClearanceActionClassForStage(input.stage)
  if (input.mode === 'disabled') {
    return {
      mode: 'disabled',
      admitted: true,
      stage: input.stage,
      actionClass,
      packet: null,
      clearanceMarket: null,
      stageCredit: null,
      evidencePressure: null,
      reason: 'StageClearanceDisabled',
      message: 'stage clearance enforcement disabled',
      annotations: {},
      parameters: {},
    }
  }

  const packet =
    input.packets.find(
      (entry) =>
        entry.namespace === input.namespace &&
        entry.swarm_name === input.swarmName &&
        entry.stage === input.stage &&
        entry.action_class === actionClass,
    ) ?? null
  if (!packet) {
    const admitted = input.mode === 'shadow'
    return {
      mode: input.mode,
      admitted,
      stage: input.stage,
      actionClass,
      packet: null,
      clearanceMarket: null,
      stageCredit: null,
      evidencePressure: null,
      reason: 'StageClearanceMissing',
      message: `missing stage clearance packet for ${input.swarmName}/${input.stage}/${actionClass}`,
      annotations: {},
      parameters: {},
    }
  }

  const clearanceMarket = clearanceMarketTraceForPacket(input.clearanceMarket, packet)
  const nowMs = input.nowMs ?? Date.now()
  const stageCredit = stageCreditTraceForPacket(input.clearanceMarket, packet, nowMs)
  const evidencePressure = evidencePressureTraceForAction(input.clearanceMarket, actionClass)
  const trace = buildStageClearanceTrace(packet, input.mode, clearanceMarket, stageCredit, evidencePressure)
  const freshUntilMs = Date.parse(packet.fresh_until)
  if (!Number.isFinite(freshUntilMs) || freshUntilMs <= nowMs) {
    return {
      mode: input.mode,
      admitted: input.mode === 'shadow',
      stage: input.stage,
      actionClass,
      packet,
      clearanceMarket,
      stageCredit,
      evidencePressure,
      reason: 'StageClearanceStale',
      message: `stage clearance packet ${packet.packet_id} is stale`,
      ...trace,
    }
  }

  if (input.mode === 'hold' && packet.decision !== 'allow') {
    return {
      mode: input.mode,
      admitted: false,
      stage: input.stage,
      actionClass,
      packet,
      clearanceMarket,
      stageCredit,
      evidencePressure,
      reason: 'StageClearanceHeld',
      message: summarizeStageClearanceBlock(packet, clearanceMarket),
      ...trace,
    }
  }
  if (input.mode === 'hold' && clearanceMarket?.decision && clearanceMarket.decision !== 'allow') {
    return {
      mode: input.mode,
      admitted: false,
      stage: input.stage,
      actionClass,
      packet,
      clearanceMarket,
      stageCredit,
      evidencePressure,
      reason: 'StageClearanceHeld',
      message: `clearance market stage admission ${clearanceMarket.stageAdmissionId ?? clearanceMarket.ledgerId} is ${
        clearanceMarket.decision
      }; clearance ledger: ${clearanceMarket.ledgerId}${
        clearanceMarket.selectedRepairLotRef ? `; selected repair lot: ${clearanceMarket.selectedRepairLotRef}` : ''
      }`,
      ...trace,
    }
  }
  if (input.mode === 'hold' && packet.max_launches === 0) {
    return {
      mode: input.mode,
      admitted: false,
      stage: input.stage,
      actionClass,
      packet,
      clearanceMarket,
      stageCredit,
      evidencePressure,
      reason: 'StageClearanceLaunchBudgetExhausted',
      message: `stage clearance packet ${packet.packet_id} has no launch budget`,
      ...trace,
    }
  }
  if (evidencePressure && evidencePressureEnforced(evidencePressure)) {
    const pressureFreshUntilMs = Date.parse(evidencePressure.freshUntil ?? '')
    if (!Number.isFinite(pressureFreshUntilMs) || pressureFreshUntilMs <= nowMs) {
      return {
        mode: input.mode,
        admitted: false,
        stage: input.stage,
        actionClass,
        packet,
        clearanceMarket,
        stageCredit,
        evidencePressure,
        reason: 'EvidencePressureStale',
        message: `evidence pressure ledger ${evidencePressure.ledgerId} is stale`,
        ...trace,
      }
    }
    if (evidencePressure.decision !== 'allow') {
      return {
        mode: input.mode,
        admitted: false,
        stage: input.stage,
        actionClass,
        packet,
        clearanceMarket,
        stageCredit,
        evidencePressure,
        reason: 'EvidencePressureHeld',
        message: `evidence pressure budget ${evidencePressure.ledgerId}/${actionClass} is ${
          evidencePressure.decision ?? 'missing'
        }${evidencePressure.reasonCodes.length > 0 ? `: ${evidencePressure.reasonCodes.join(', ')}` : ''}`,
        ...trace,
      }
    }
  }

  return {
    mode: input.mode,
    admitted: true,
    stage: input.stage,
    actionClass,
    packet,
    clearanceMarket,
    stageCredit,
    evidencePressure,
    reason: input.mode === 'hold' ? 'StageClearanceAllowed' : 'StageClearanceShadow',
    message:
      input.mode === 'hold'
        ? `stage clearance packet ${packet.packet_id} allows launch`
        : `stage clearance packet ${packet.packet_id} recorded in shadow mode`,
    ...trace,
  }
}

export const resolveStageClearanceUnavailable = (
  stage: StageName,
  actionClass: ActionSloBudgetActionClass,
  mode: StageClearanceMode,
  errorMessage: string,
): StageClearanceLaunchAdmission => ({
  mode,
  admitted: mode === 'shadow',
  stage,
  actionClass,
  packet: null,
  clearanceMarket: null,
  stageCredit: null,
  evidencePressure: null,
  reason: 'StageClearanceUnavailable',
  message: `stage clearance snapshot unavailable: ${errorMessage}`,
  annotations: {},
  parameters: {},
})

export const resolveStageClearanceForStage = async (input: {
  namespace: string
  swarmName: string
  stage: StageName
  config?: ReturnType<typeof resolveSupportingPrimitivesConfig>
  packets?: StageClearancePacket[]
  clearanceMarket?: StageClearanceAdmissionSnapshot | null
  nowMs?: number
  onUnavailable?: (message: string) => void
}): Promise<StageClearanceLaunchAdmission> => {
  const config = input.config ?? resolveSupportingPrimitivesConfig(process.env)
  const holdStages = normalizeStageClearanceHoldStages(config.stageClearanceHoldStages)
  const mode = effectiveStageClearanceMode(config.stageClearanceEnforcement, holdStages, input.stage)
  const actionClass = stageClearanceActionClassForStage(input.stage)
  if (mode === 'disabled') {
    return resolveStageClearanceAdmissionFromPackets({
      namespace: input.namespace,
      swarmName: input.swarmName,
      stage: input.stage,
      mode,
      packets: [],
      clearanceMarket: null,
      nowMs: input.nowMs,
    })
  }

  try {
    const snapshot = input.packets
      ? {
          packets: input.packets,
          clearanceMarketLedgerId: input.clearanceMarket?.clearanceMarketLedgerId ?? null,
          stageAdmissions: input.clearanceMarket?.stageAdmissions ?? [],
          stageCredit: input.clearanceMarket?.stageCredit ?? null,
          evidencePressure: input.clearanceMarket?.evidencePressure ?? null,
        }
      : await fetchStageClearanceStatusSnapshot(input.namespace, config)
    return resolveStageClearanceAdmissionFromPackets({
      namespace: input.namespace,
      swarmName: input.swarmName,
      stage: input.stage,
      mode,
      packets: snapshot.packets,
      clearanceMarket: snapshot,
      nowMs: input.nowMs,
    })
  } catch (error) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error)
    input.onUnavailable?.(message)
    return resolveStageClearanceUnavailable(input.stage, actionClass, mode, message)
  }
}

export const stageClearanceStatusForStage = (admission: StageClearanceLaunchAdmission) => ({
  mode: admission.mode,
  admitted: admission.admitted,
  stage: admission.stage,
  actionClass: admission.actionClass,
  packetId: admission.packet?.packet_id ?? null,
  decision: admission.packet?.decision ?? null,
  freshUntil: admission.packet?.fresh_until ?? null,
  maxLaunches: admission.packet?.max_launches ?? null,
  reasonCodes: admission.packet?.reason_codes ?? [],
  requiredRepairAction: admission.packet?.required_repair_action ?? null,
  rollbackTarget: admission.packet?.rollback_target ?? null,
  clearanceMarketLedgerId: admission.clearanceMarket?.ledgerId ?? null,
  clearanceMarketStageAdmissionId: admission.clearanceMarket?.stageAdmissionId ?? null,
  clearanceMarketStageDecision: admission.clearanceMarket?.decision ?? null,
  clearanceMarketSelectedRepairLotRef: admission.clearanceMarket?.selectedRepairLotRef ?? null,
  stageCreditLedgerId: admission.stageCredit?.ledgerId ?? null,
  stageCreditAccountId: admission.stageCredit?.accountId ?? null,
  stageCreditDecision: admission.stageCredit?.decision ?? null,
  stageCreditMode: admission.stageCredit?.mode ?? null,
  stageCreditFreshUntil: admission.stageCredit?.freshUntil ?? null,
  stageCreditReasonCodes: admission.stageCredit?.reasonCodes ?? [],
  runnerSlotFutureId: admission.stageCredit?.runnerSlotFutureId ?? null,
  runnerSlotFutureExpiresAt: admission.stageCredit?.runnerSlotFutureExpiresAt ?? null,
  stageCreditSelectedRepairLotRef: admission.stageCredit?.selectedRepairLotRef ?? null,
  evidencePressureLedgerId: admission.evidencePressure?.ledgerId ?? null,
  evidencePressureDecision: admission.evidencePressure?.decision ?? null,
  evidencePressureMode: admission.evidencePressure?.mode ?? null,
  evidencePressureFreshUntil: admission.evidencePressure?.freshUntil ?? null,
  evidencePressureReasonCodes: admission.evidencePressure?.reasonCodes ?? [],
  evidencePressureWatchBackoffState: admission.evidencePressure?.watchBackoffState ?? null,
  evidencePressureRequiredRepairReceipts: admission.evidencePressure?.requiredRepairReceipts ?? [],
  reason: admission.reason,
  message: admission.message,
})
