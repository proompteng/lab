import type {
  ActionSloBudgetActionClass,
  StageClearanceDecision,
  StageClearancePacket,
} from '~/data/agents-control-plane'
import { asRecord, asString } from '~/server/primitives-http'
import { resolveSupportingPrimitivesConfig } from '~/server/supporting-primitives-config'
import {
  SWARM_STAGE_CLEARANCE_ANNOTATION_ACTION_CLASS,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DECISION,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_DECISION,
  SWARM_STAGE_CLEARANCE_ANNOTATION_DEPENDENCY_VERDICT_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_FRESH_UNTIL,
  SWARM_STAGE_CLEARANCE_ANNOTATION_MODE,
  SWARM_STAGE_CLEARANCE_ANNOTATION_PACKET_ID,
  SWARM_STAGE_CLEARANCE_ANNOTATION_REASON_CODES,
  SWARM_STAGE_CLEARANCE_ANNOTATION_REQUIRED_REPAIR_ACTION,
} from '~/server/supporting-primitives-schedule-runner'
import type { StageName } from '~/server/supporting-primitives-swarm-config'

export type StageClearanceMode = ReturnType<typeof resolveSupportingPrimitivesConfig>['stageClearanceEnforcement']

export type StageClearanceLaunchAdmission = {
  mode: StageClearanceMode
  admitted: boolean
  stage: StageName
  actionClass: ActionSloBudgetActionClass
  packet: StageClearancePacket | null
  reason:
    | 'StageClearanceDisabled'
    | 'StageClearanceAllowed'
    | 'StageClearanceShadow'
    | 'StageClearanceUnavailable'
    | 'StageClearanceMissing'
    | 'StageClearanceStale'
    | 'StageClearanceHeld'
    | 'StageClearanceLaunchBudgetExhausted'
  message: string
  annotations: Record<string, string>
  parameters: Record<string, string>
}

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

export const fetchStageClearancePackets = async (
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
  return asArray(status.stage_clearance_packets).map(readStageClearancePacket).filter(isPresent)
}

const buildStageClearanceTrace = (
  packet: StageClearancePacket,
  mode: StageClearanceMode,
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
  return { annotations, parameters }
}

const summarizeStageClearanceBlock = (packet: StageClearancePacket) => {
  const reasons = packet.reason_codes.length > 0 ? `: ${packet.reason_codes.join(', ')}` : ''
  const repair = packet.required_repair_action ? `; required repair: ${packet.required_repair_action}` : ''
  return `stage clearance packet ${packet.packet_id} is ${packet.decision}${reasons}${repair}`
}

export const resolveStageClearanceAdmissionFromPackets = (input: {
  namespace: string
  swarmName: string
  stage: StageName
  mode: StageClearanceMode
  packets: StageClearancePacket[]
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
      reason: 'StageClearanceMissing',
      message: `missing stage clearance packet for ${input.swarmName}/${input.stage}/${actionClass}`,
      annotations: {},
      parameters: {},
    }
  }

  const trace = buildStageClearanceTrace(packet, input.mode)
  const freshUntilMs = Date.parse(packet.fresh_until)
  if (!Number.isFinite(freshUntilMs) || freshUntilMs <= (input.nowMs ?? Date.now())) {
    return {
      mode: input.mode,
      admitted: input.mode === 'shadow',
      stage: input.stage,
      actionClass,
      packet,
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
      reason: 'StageClearanceHeld',
      message: summarizeStageClearanceBlock(packet),
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
      reason: 'StageClearanceLaunchBudgetExhausted',
      message: `stage clearance packet ${packet.packet_id} has no launch budget`,
      ...trace,
    }
  }

  return {
    mode: input.mode,
    admitted: true,
    stage: input.stage,
    actionClass,
    packet,
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
      nowMs: input.nowMs,
    })
  }

  try {
    const packets = input.packets ?? (await fetchStageClearancePackets(input.namespace, config))
    return resolveStageClearanceAdmissionFromPackets({
      namespace: input.namespace,
      swarmName: input.swarmName,
      stage: input.stage,
      mode,
      packets,
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
  reason: admission.reason,
  message: admission.message,
})
