import type { AdmissionPassportStatus, RecoveryWarrantStatus } from '~/server/control-plane-status-types'
import { asRecord, asString } from '~/server/primitives-http'
import { resolveSupportingPrimitivesConfig } from '~/server/supporting-primitives-config'
import { hashNameSuffix } from '~/server/supporting-primitives-naming'

export const STAGE_NAMES = ['discover', 'plan', 'implement', 'verify'] as const
export type StageName = (typeof STAGE_NAMES)[number]
export type StageTargetRef = { kind: 'AgentRun' | 'OrchestrationRun'; name: string; namespace: string }

export const STAGE_CADENCE_KEY: Record<StageName, string> = {
  discover: 'discoverEvery',
  plan: 'planEvery',
  implement: 'implementEvery',
  verify: 'verifyEvery',
}

type SwarmPersonaRole = 'architect' | 'engineer' | 'deployer'

const STAGE_PERSONA_ROLE: Record<StageName, SwarmPersonaRole> = {
  discover: 'architect',
  plan: 'architect',
  implement: 'engineer',
  verify: 'deployer',
}

export const STAGE_LAST_RUN_KEY: Record<StageName, string> = {
  discover: 'lastDiscoverAt',
  plan: 'lastPlanAt',
  implement: 'lastImplementAt',
  verify: 'lastVerifyAt',
}

const STAGE_HOURLY_STAGGER_OFFSET: Record<StageName, number> = {
  discover: 0,
  plan: 15,
  implement: 30,
  verify: 45,
}

export const SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE = resolveSupportingPrimitivesConfig(
  process.env,
).swarmRequirementMaxDispatchPerReconcile
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
export const SWARM_RUNTIME_ADMISSION_DESIGN_REF =
  'docs/agents/designs/61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md'
export const SWARM_RUNTIME_PROOF_DESIGN_REF =
  'docs/agents/designs/65-jangar-recovery-warrants-and-runtime-proof-cells-contract-2026-03-21.md'
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
export const buildSwarmAdmissionTrace = (
  passport: AdmissionPassportStatus | null,
  warrant: RecoveryWarrantStatus | null = null,
) => {
  if (!passport) {
    return {
      annotations: {},
      parameters: {},
    }
  }

  const requiredRuntimeKits = passport.required_runtime_kits.join(',')
  const requiredProofCells = warrant?.required_proof_cell_ids.join(',') ?? ''
  const annotations: Record<string, string> = {
    [SWARM_ADMISSION_ANNOTATION_RUNTIME_ADMISSION_DESIGN_REF]: SWARM_RUNTIME_ADMISSION_DESIGN_REF,
    [SWARM_ADMISSION_ANNOTATION_PASSPORT_ID]: passport.admission_passport_id,
    [SWARM_ADMISSION_ANNOTATION_DECISION]: passport.decision,
    [SWARM_ADMISSION_ANNOTATION_RECOVERY_DIGEST]: passport.recovery_case_set_digest,
    [SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST]: passport.runtime_kit_set_digest,
    [SWARM_ADMISSION_ANNOTATION_RUNTIME_KITS]: requiredRuntimeKits,
    [SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION]: passport.producer_revision,
  }
  const parameters: Record<string, string> = {
    swarmRuntimeAdmissionDesignRef: SWARM_RUNTIME_ADMISSION_DESIGN_REF,
    swarmAdmissionPassportId: passport.admission_passport_id,
    swarmAdmissionDecision: passport.decision,
    swarmRecoveryCaseSetDigest: passport.recovery_case_set_digest,
    swarmRuntimeKitSetDigest: passport.runtime_kit_set_digest,
    swarmRequiredRuntimeKits: requiredRuntimeKits,
    swarmAdmissionProducerRevision: passport.producer_revision,
  }
  if (warrant) {
    annotations[SWARM_ADMISSION_ANNOTATION_RUNTIME_PROOF_DESIGN_REF] = SWARM_RUNTIME_PROOF_DESIGN_REF
    annotations[SWARM_ADMISSION_ANNOTATION_WARRANT_ID] = warrant.recovery_warrant_id
    annotations[SWARM_ADMISSION_ANNOTATION_WARRANT_STATUS] = warrant.status
    annotations[SWARM_ADMISSION_ANNOTATION_PROOF_CELLS] = requiredProofCells
    parameters.swarmRuntimeProofDesignRef = SWARM_RUNTIME_PROOF_DESIGN_REF
    parameters.swarmRecoveryWarrantId = warrant.recovery_warrant_id
    parameters.swarmRecoveryWarrantStatus = warrant.status
    parameters.swarmRequiredProofCells = requiredProofCells
  }

  return { annotations, parameters }
}
export const SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT = resolveSupportingPrimitivesConfig(
  process.env,
).swarmRequirementMaxPayloadBytes
const SWARM_DEFAULT_NATS_URL = resolveSupportingPrimitivesConfig(process.env).swarmDefaultNatsUrl
const SWARM_DEFAULT_NATS_SUBJECT_PREFIX = resolveSupportingPrimitivesConfig(process.env).swarmDefaultNatsSubjectPrefix
const SWARM_DEFAULT_NATS_CHANNEL = resolveSupportingPrimitivesConfig(process.env).swarmDefaultNatsChannel
export const SWARM_REQUIREMENT_MAX_ATTEMPTS = resolveSupportingPrimitivesConfig(process.env).swarmRequirementMaxAttempts

export const deriveStageStaggerMinute = (swarmName: string, stage: StageName) => {
  const base = Number.parseInt(hashNameSuffix(swarmName), 36)
  const swarmOffset = Number.isFinite(base) ? base % 15 : 0
  return (STAGE_HOURLY_STAGGER_OFFSET[stage] + swarmOffset) % 60
}

const normalizeRequirementPriority = (value: string | undefined) => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return 2
  if (
    normalized === 'p0' ||
    normalized === 'critical' ||
    normalized === 'urgent' ||
    normalized === 'blocker' ||
    normalized === 'highest'
  ) {
    return 0
  }
  if (normalized === 'p1' || normalized === 'high') {
    return 1
  }
  if (normalized === 'p2' || normalized === 'medium' || normalized === 'normal') {
    return 2
  }
  if (normalized === 'p3' || normalized === 'low') {
    return 3
  }
  return 2
}

const parseSignalPayloadRecord = (payload: unknown) => {
  const directRecord = asRecord(payload)
  if (directRecord) {
    return directRecord
  }
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown
      return asRecord(parsed)
    } catch {
      return null
    }
  }
  return null
}

export const resolveRequirementPriorityScore = (signal: Record<string, unknown>) => {
  const signalSpec = asRecord(signal.spec) ?? {}
  const signalMetadata = asRecord(signal.metadata) ?? {}
  const payloadRecord = parseSignalPayloadRecord(signalSpec.payload)
  const payloadContextRecord = payloadRecord ? asRecord(payloadRecord.context) : null
  const candidates = [
    asString(signalSpec.priority),
    asString(signalSpec.severity),
    asString(payloadRecord?.priority),
    asString(payloadRecord?.severity),
    asString(payloadContextRecord?.priority),
    asString(asRecord(signalMetadata.labels)?.priority),
  ]
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return normalizeRequirementPriority(candidate)
    }
  }
  return 2
}

export const sortRequirementSignalsForDispatch = (signals: Record<string, unknown>[]) => {
  return signals
    .map((signal) => {
      const metadata = asRecord(signal.metadata) ?? {}
      const signalName = asString(metadata.name) ?? ''
      const createdAt = asString(metadata.creationTimestamp)
      const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN
      return {
        signal,
        signalName,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Number.MAX_SAFE_INTEGER,
        priority: resolveRequirementPriorityScore(signal),
      }
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority
      }
      if (left.createdAtMs !== right.createdAtMs) {
        return left.createdAtMs - right.createdAtMs
      }
      return left.signalName.localeCompare(right.signalName)
    })
    .map((entry) => entry.signal)
}

export type SwarmNatsIntegration = {
  url: string
  subjectPrefix: string
  channel: string
  personas: Partial<Record<SwarmPersonaRole, SwarmPersona>>
}

type SwarmAgentIdentity = {
  workerId: string
  identity: string
  role: string
  humanName: string
}

type SwarmPersona = {
  role: SwarmPersonaRole
  humanName: string
  workerIdentity: string
}

export type SwarmMissionContract = {
  ledgerRef: string
  businessMetric: string
  validationContract: string[]
  valueGates: string[]
  handoffRequiredFields: string[]
  sourceDesign: string
}

const DEFAULT_SWARM_PERSONAS: Record<string, { personas: Record<SwarmPersonaRole, SwarmPersona> }> = {
  'jangar-control-plane': {
    personas: {
      architect: {
        role: 'architect',
        humanName: 'Victor Chen',
        workerIdentity: 'victor-chen-jangar-architect',
      },
      engineer: {
        role: 'engineer',
        humanName: 'Elise Novak',
        workerIdentity: 'elise-novak-jangar-engineer',
      },
      deployer: {
        role: 'deployer',
        humanName: 'Marco Silva',
        workerIdentity: 'marco-silva-jangar-deployer',
      },
    },
  },
  'torghut-quant': {
    personas: {
      architect: {
        role: 'architect',
        humanName: 'Gideon Park',
        workerIdentity: 'gideon-park-torghut-architect',
      },
      engineer: {
        role: 'engineer',
        humanName: 'Naomi Ibarra',
        workerIdentity: 'naomi-ibarra-torghut-engineer',
      },
      deployer: {
        role: 'deployer',
        humanName: 'Julian Hart',
        workerIdentity: 'julian-hart-torghut-deployer',
      },
    },
  },
}

const resolveDefaultSwarmPersonaConfig = (swarmName: string, owner: Record<string, unknown>) => {
  const ownerId = asString(owner.id)?.toLowerCase() ?? ''
  if (DEFAULT_SWARM_PERSONAS[swarmName]) {
    return DEFAULT_SWARM_PERSONAS[swarmName]
  }
  if (swarmName.toLowerCase().includes('torghut') || ownerId.includes('trading')) {
    return DEFAULT_SWARM_PERSONAS['torghut-quant']
  }
  return DEFAULT_SWARM_PERSONAS['jangar-control-plane']
}

export const normalizeLabelValue = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  if (!normalized) return 'swarm'
  const trimmed = normalized
    .slice(0, 63)
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  return trimmed || 'swarm'
}

export const parseStringList = (raw: unknown) => {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
}

const SWARM_AGENTIC_MISSION_DESIGN = 'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md'

const DEFAULT_HANDOFF_FIELDS = [
  'objective',
  'files_changed_or_inspected',
  'commands_and_exit_codes',
  'tests_passed_or_failed',
  'unresolved_issues',
  'risk_and_rollback',
  'exact_next_action',
]

const resolveDefaultMissionContract = (swarmName: string, owner: Record<string, unknown>): SwarmMissionContract => {
  const ownerId = asString(owner.id)?.toLowerCase() ?? ''
  const isTorghut = swarmName.toLowerCase().includes('torghut') || ownerId.includes('trading')
  if (isTorghut) {
    return {
      ledgerRef: `/workspace/.agentrun/swarm/${swarmName}-mission-ledger.md`,
      businessMetric:
        'increase Torghut revenue readiness through post-cost profit evidence, routeable hypotheses, data freshness, execution quality, or safer capital gates',
      validationContract: [
        'cite the governing Torghut design or runtime requirement before implementation',
        'produce a production PR for code/config changes, with targeted tests and all required Torghut checks green',
        'prove merged runtime changes through image promotion, GitOps sync, live Torghut health/readiness, and relevant trading/evidence status',
        'record the business metric moved or the exact blocker preventing revenue impact',
      ],
      valueGates: [
        'post_cost_daily_net_pnl',
        'routeable_candidate_count',
        'zero_notional_or_stale_evidence_rate',
        'fill_tca_or_slippage_quality',
        'capital_gate_safety',
      ],
      handoffRequiredFields: DEFAULT_HANDOFF_FIELDS,
      sourceDesign: SWARM_AGENTIC_MISSION_DESIGN,
    }
  }

  return {
    ledgerRef: `/workspace/.agentrun/swarm/${swarmName}-mission-ledger.md`,
    businessMetric:
      'increase Jangar control-plane throughput and reliability through fewer failed runs, faster green PR-to-rollout loops, stronger admission, memory, NATS, CI, deploy verification, or observability',
    validationContract: [
      'cite the governing Jangar design or runtime requirement before implementation',
      'produce a production PR for code/config changes, with targeted tests and all required Jangar checks green',
      'prove merged runtime changes through GitOps sync, live readiness/control-plane status, and rollout evidence',
      'record the machine-improvement metric moved or the exact blocker preventing autonomy impact',
    ],
    valueGates: [
      'failed_agentrun_rate',
      'pr_to_rollout_latency',
      'ready_status_truth',
      'manual_intervention_count',
      'handoff_evidence_quality',
    ],
    handoffRequiredFields: DEFAULT_HANDOFF_FIELDS,
    sourceDesign: SWARM_AGENTIC_MISSION_DESIGN,
  }
}

const resolveMissionList = (value: unknown, fallback: string[]) => {
  const resolved = parseStringList(value)
  return resolved.length > 0 ? resolved : fallback
}

const resolveMissionString = (value: unknown, fallback: string) => {
  const resolved = asString(value)?.trim()
  return resolved && resolved.length > 0 ? resolved : fallback
}

export const resolveSwarmMissionContract = (
  spec: Record<string, unknown>,
  owner: Record<string, unknown>,
  swarmName: string,
): SwarmMissionContract => {
  const mission = asRecord(spec.mission) ?? {}
  const defaults = resolveDefaultMissionContract(swarmName, owner)
  return {
    ledgerRef: resolveMissionString(mission.ledgerRef, defaults.ledgerRef),
    businessMetric: resolveMissionString(mission.businessMetric, defaults.businessMetric),
    validationContract: resolveMissionList(mission.validationContract, defaults.validationContract),
    valueGates: resolveMissionList(mission.valueGates, defaults.valueGates),
    handoffRequiredFields: resolveMissionList(mission.handoffRequiredFields, defaults.handoffRequiredFields),
    sourceDesign: resolveMissionString(mission.sourceDesign, defaults.sourceDesign),
  }
}

const mergeUniqueStrings = (...values: string[][]) => {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const list of values) {
    for (const value of list) {
      if (seen.has(value)) continue
      seen.add(value)
      merged.push(value)
    }
  }
  return merged
}

export const resolveSwarmRunSecrets = (existingSecrets: string[]) => mergeUniqueStrings(existingSecrets)

const normalizeNatsUrl = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    return url.protocol === 'nats:' || url.protocol === 'tls:' ? trimmed : ''
  } catch {
    return ''
  }
}

const normalizeSubjectToken = (value: string | null | undefined, fallback: string) => {
  const normalized = value?.trim()
  if (!normalized) return fallback
  return normalized.replace(/^\.+/, '').replace(/\.+$/, '') || fallback
}

export const resolveSwarmNatsIntegration = (
  spec: Record<string, unknown>,
  owner: Record<string, unknown>,
  swarmName: string,
): SwarmNatsIntegration => {
  const integrations = asRecord(spec.integrations) ?? {}
  const nats = asRecord(integrations.nats) ?? {}
  const url = normalizeNatsUrl(asString(nats.url)) || SWARM_DEFAULT_NATS_URL
  const subjectPrefix = normalizeSubjectToken(asString(nats.subjectPrefix), SWARM_DEFAULT_NATS_SUBJECT_PREFIX)
  const channel = normalizeSubjectToken(asString(nats.channel), SWARM_DEFAULT_NATS_CHANNEL)
  const rawPersonas = asRecord(nats.personas) ?? {}
  const personaEntries = Object.entries(rawPersonas)
    .map(([role, value]) => {
      if (role !== 'architect' && role !== 'engineer' && role !== 'deployer') return null
      const record = asRecord(value) ?? {}
      return {
        role,
        humanName: asString(record.humanName)?.trim() ?? '',
        workerIdentity: asString(record.workerIdentity)?.trim() ?? '',
      } satisfies SwarmPersona
    })
    .filter((persona): persona is SwarmPersona => persona !== null)
  const explicitPersonas = Object.fromEntries(personaEntries.map((persona) => [persona.role, persona])) as Partial<
    Record<SwarmPersonaRole, SwarmPersona>
  >
  const defaultConfig = resolveDefaultSwarmPersonaConfig(swarmName, owner)
  const personas =
    explicitPersonas.architect && explicitPersonas.engineer && explicitPersonas.deployer
      ? explicitPersonas
      : (defaultConfig?.personas ?? explicitPersonas)
  return {
    url,
    subjectPrefix,
    channel,
    personas,
  }
}

export const resolveSwarmPersonaForStage = (nats: SwarmNatsIntegration, stage: StageName) => {
  return nats.personas[STAGE_PERSONA_ROLE[stage]]
}

export const buildSwarmAgentIdentity = (input: {
  swarmName: string
  stage: StageName
  persona: SwarmPersona
  seedSuffix?: string
}) => {
  const seed = `${input.swarmName}:${input.stage}:${input.seedSuffix ?? ''}`
  const hash = hashNameSuffix(seed)
  const workerId = `worker-${hash.slice(0, 8)}`
  return {
    workerId,
    identity: input.persona.workerIdentity.slice(0, 120),
    role: input.persona.role,
    humanName: input.persona.humanName,
  }
}

export const buildSwarmRuntimeParameters = (input: {
  ownerChannel: string | null
  nats: SwarmNatsIntegration
  identity: SwarmAgentIdentity
  mission?: SwarmMissionContract
}) => {
  const parameters: Record<string, string> = {
    swarmAgentWorkerId: input.identity.workerId,
    swarmAgentIdentity: input.identity.identity,
    swarmAgentRole: input.identity.role,
    swarmHumanName: input.identity.humanName,
    natsUrl: input.nats.url,
    natsSubjectPrefix: input.nats.subjectPrefix,
    natsChannel: input.nats.channel,
  }
  if (input.ownerChannel) parameters.ownerChannel = input.ownerChannel
  if (input.mission) {
    parameters.swarmMissionLedgerRef = input.mission.ledgerRef
    parameters.swarmBusinessMetric = input.mission.businessMetric
    parameters.swarmValidationContract = JSON.stringify(input.mission.validationContract)
    parameters.swarmValueGates = JSON.stringify(input.mission.valueGates)
    parameters.swarmHandoffRequiredFields = JSON.stringify(input.mission.handoffRequiredFields)
    parameters.swarmSourceDesign = input.mission.sourceDesign
  }
  return parameters
}

export const buildSwarmScheduleAnnotations = (input: {
  ownerChannel: string | null
  nats: SwarmNatsIntegration
  identity: SwarmAgentIdentity
  mission?: SwarmMissionContract
}) => {
  const annotations: Record<string, string> = {
    [SWARM_SCHEDULE_ANNOTATION_WORKER_ID]: input.identity.workerId,
    [SWARM_SCHEDULE_ANNOTATION_IDENTITY]: input.identity.identity,
    [SWARM_SCHEDULE_ANNOTATION_ROLE]: input.identity.role,
    [SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME]: input.identity.humanName,
    [SWARM_SCHEDULE_ANNOTATION_NATS_URL]: input.nats.url,
    [SWARM_SCHEDULE_ANNOTATION_NATS_SUBJECT_PREFIX]: input.nats.subjectPrefix,
    [SWARM_SCHEDULE_ANNOTATION_NATS_CHANNEL]: input.nats.channel,
  }
  if (input.ownerChannel) annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL] = input.ownerChannel
  if (input.mission) {
    annotations[SWARM_MISSION_ANNOTATION_LEDGER_REF] = input.mission.ledgerRef
    annotations[SWARM_MISSION_ANNOTATION_BUSINESS_METRIC] = input.mission.businessMetric
    annotations[SWARM_MISSION_ANNOTATION_VALIDATION_CONTRACT] = JSON.stringify(input.mission.validationContract)
    annotations[SWARM_MISSION_ANNOTATION_VALUE_GATES] = JSON.stringify(input.mission.valueGates)
    annotations[SWARM_MISSION_ANNOTATION_HANDOFF_FIELDS] = JSON.stringify(input.mission.handoffRequiredFields)
    annotations[SWARM_MISSION_ANNOTATION_SOURCE_DESIGN] = input.mission.sourceDesign
  }
  return annotations
}

export const resolveScheduleRuntimeInjection = (schedule: Record<string, unknown>) => {
  const annotations = asRecord(schedule.metadata && asRecord(schedule.metadata)?.annotations) ?? {}
  const ownerChannel = asString(annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL]) ?? null
  const workerId = asString(annotations[SWARM_SCHEDULE_ANNOTATION_WORKER_ID])
  const identity = asString(annotations[SWARM_SCHEDULE_ANNOTATION_IDENTITY])
  const role = asString(annotations[SWARM_SCHEDULE_ANNOTATION_ROLE])
  const humanName = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME])
  const natsUrl = asString(annotations[SWARM_SCHEDULE_ANNOTATION_NATS_URL])
  const natsSubjectPrefix = asString(annotations[SWARM_SCHEDULE_ANNOTATION_NATS_SUBJECT_PREFIX])
  const natsChannel = asString(annotations[SWARM_SCHEDULE_ANNOTATION_NATS_CHANNEL])
  const missionLedgerRef = asString(annotations[SWARM_MISSION_ANNOTATION_LEDGER_REF])
  const businessMetric = asString(annotations[SWARM_MISSION_ANNOTATION_BUSINESS_METRIC])
  const validationContract = asString(annotations[SWARM_MISSION_ANNOTATION_VALIDATION_CONTRACT])
  const valueGates = asString(annotations[SWARM_MISSION_ANNOTATION_VALUE_GATES])
  const handoffRequiredFields = asString(annotations[SWARM_MISSION_ANNOTATION_HANDOFF_FIELDS])
  const sourceDesign = asString(annotations[SWARM_MISSION_ANNOTATION_SOURCE_DESIGN])
  const runtimeAdmissionDesignRef = asString(annotations[SWARM_ADMISSION_ANNOTATION_RUNTIME_ADMISSION_DESIGN_REF])
  const runtimeProofDesignRef = asString(annotations[SWARM_ADMISSION_ANNOTATION_RUNTIME_PROOF_DESIGN_REF])
  const admissionPassportId = asString(annotations[SWARM_ADMISSION_ANNOTATION_PASSPORT_ID])
  const admissionDecision = asString(annotations[SWARM_ADMISSION_ANNOTATION_DECISION])
  const recoveryCaseSetDigest = asString(annotations[SWARM_ADMISSION_ANNOTATION_RECOVERY_DIGEST])
  const runtimeKitSetDigest = asString(annotations[SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST])
  const requiredRuntimeKits = asString(annotations[SWARM_ADMISSION_ANNOTATION_RUNTIME_KITS])
  const admissionProducerRevision = asString(annotations[SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION])
  const recoveryWarrantId = asString(annotations[SWARM_ADMISSION_ANNOTATION_WARRANT_ID])
  const recoveryWarrantStatus = asString(annotations[SWARM_ADMISSION_ANNOTATION_WARRANT_STATUS])
  const requiredProofCells = asString(annotations[SWARM_ADMISSION_ANNOTATION_PROOF_CELLS])

  const parameters: Record<string, string> = {}
  if (ownerChannel) parameters.ownerChannel = ownerChannel
  if (workerId) parameters.swarmAgentWorkerId = workerId
  if (identity) parameters.swarmAgentIdentity = identity
  if (role) parameters.swarmAgentRole = role
  if (humanName) parameters.swarmHumanName = humanName
  if (natsUrl) parameters.natsUrl = natsUrl
  if (natsSubjectPrefix) parameters.natsSubjectPrefix = natsSubjectPrefix
  if (natsChannel) parameters.natsChannel = natsChannel
  if (missionLedgerRef) parameters.swarmMissionLedgerRef = missionLedgerRef
  if (businessMetric) parameters.swarmBusinessMetric = businessMetric
  if (validationContract) parameters.swarmValidationContract = validationContract
  if (valueGates) parameters.swarmValueGates = valueGates
  if (handoffRequiredFields) parameters.swarmHandoffRequiredFields = handoffRequiredFields
  if (sourceDesign) parameters.swarmSourceDesign = sourceDesign
  if (runtimeAdmissionDesignRef) parameters.swarmRuntimeAdmissionDesignRef = runtimeAdmissionDesignRef
  if (runtimeProofDesignRef) parameters.swarmRuntimeProofDesignRef = runtimeProofDesignRef
  if (admissionPassportId) parameters.swarmAdmissionPassportId = admissionPassportId
  if (admissionDecision) parameters.swarmAdmissionDecision = admissionDecision
  if (recoveryCaseSetDigest) parameters.swarmRecoveryCaseSetDigest = recoveryCaseSetDigest
  if (runtimeKitSetDigest) parameters.swarmRuntimeKitSetDigest = runtimeKitSetDigest
  if (requiredRuntimeKits) parameters.swarmRequiredRuntimeKits = requiredRuntimeKits
  if (admissionProducerRevision) parameters.swarmAdmissionProducerRevision = admissionProducerRevision
  if (recoveryWarrantId) parameters.swarmRecoveryWarrantId = recoveryWarrantId
  if (recoveryWarrantStatus) parameters.swarmRecoveryWarrantStatus = recoveryWarrantStatus
  if (requiredProofCells) parameters.swarmRequiredProofCells = requiredProofCells

  const runAnnotations = Object.fromEntries(
    [
      [SWARM_ADMISSION_ANNOTATION_RUNTIME_ADMISSION_DESIGN_REF, runtimeAdmissionDesignRef],
      [SWARM_ADMISSION_ANNOTATION_RUNTIME_PROOF_DESIGN_REF, runtimeProofDesignRef],
      [SWARM_ADMISSION_ANNOTATION_PASSPORT_ID, admissionPassportId],
      [SWARM_ADMISSION_ANNOTATION_DECISION, admissionDecision],
      [SWARM_ADMISSION_ANNOTATION_RECOVERY_DIGEST, recoveryCaseSetDigest],
      [SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST, runtimeKitSetDigest],
      [SWARM_ADMISSION_ANNOTATION_RUNTIME_KITS, requiredRuntimeKits],
      [SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION, admissionProducerRevision],
      [SWARM_ADMISSION_ANNOTATION_WARRANT_ID, recoveryWarrantId],
      [SWARM_ADMISSION_ANNOTATION_WARRANT_STATUS, recoveryWarrantStatus],
      [SWARM_ADMISSION_ANNOTATION_PROOF_CELLS, requiredProofCells],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )

  return { parameters, annotations: runAnnotations }
}
