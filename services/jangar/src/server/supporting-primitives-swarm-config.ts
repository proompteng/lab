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
export const SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL = 'swarm.proompteng.ai/huly-base-url'
export const SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE = 'swarm.proompteng.ai/huly-workspace'
export const SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT = 'swarm.proompteng.ai/huly-project'
export const SWARM_SCHEDULE_ANNOTATION_HULY_SECRET = 'swarm.proompteng.ai/huly-secret'
export const SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF = 'swarm.proompteng.ai/huly-skill-ref'
export const SWARM_SCHEDULE_ANNOTATION_HULY_TOKEN_KEY = 'swarm.proompteng.ai/huly-token-key'
export const SWARM_SCHEDULE_ANNOTATION_HULY_EXPECTED_ACTOR_KEY = 'swarm.proompteng.ai/huly-expected-actor-key'
export const SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME = 'swarm.proompteng.ai/human-name'
export const SWARM_REQUIREMENT_SCOPE_FIELD_LIMIT = resolveSupportingPrimitivesConfig(
  process.env,
).swarmRequirementMaxPayloadBytes
const SWARM_DEFAULT_HULY_BASE_URL = resolveSupportingPrimitivesConfig(process.env).swarmDefaultHulyBaseUrl
const SWARM_DEFAULT_HULY_SKILL_REF = resolveSupportingPrimitivesConfig(process.env).swarmDefaultHulySkillRef
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

export type SwarmHulyIntegration = {
  baseUrl: string
  workspace?: string
  project?: string
  secretName: string
  skillRef: string
  personas: Partial<Record<SwarmPersonaRole, SwarmPersona>>
}

type SwarmAgentIdentity = {
  workerId: string
  identity: string
  role: string
  humanName: string
  tokenKey: string
  expectedActorIdKey: string
}

type SwarmPersona = {
  role: SwarmPersonaRole
  humanName: string
  workerIdentity: string
  tokenKey: string
  expectedActorIdKey: string
}

const DEFAULT_SWARM_PERSONAS: Record<string, { secretName: string; personas: Record<SwarmPersonaRole, SwarmPersona> }> =
  {
    'jangar-control-plane': {
      secretName: 'huly-api-jangar',
      personas: {
        architect: {
          role: 'architect',
          humanName: 'Victor Chen',
          workerIdentity: 'victor-chen-jangar-architect',
          tokenKey: 'HULY_API_TOKEN_VICTOR_CHEN_JANGAR_ARCHITECT',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_VICTOR_CHEN_JANGAR_ARCHITECT',
        },
        engineer: {
          role: 'engineer',
          humanName: 'Elise Novak',
          workerIdentity: 'elise-novak-jangar-engineer',
          tokenKey: 'HULY_API_TOKEN_ELISE_NOVAK_JANGAR_ENGINEER',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_ELISE_NOVAK_JANGAR_ENGINEER',
        },
        deployer: {
          role: 'deployer',
          humanName: 'Marco Silva',
          workerIdentity: 'marco-silva-jangar-deployer',
          tokenKey: 'HULY_API_TOKEN_MARCO_SILVA_JANGAR_DEPLOYER',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_MARCO_SILVA_JANGAR_DEPLOYER',
        },
      },
    },
    'torghut-quant': {
      secretName: 'huly-api-torghut',
      personas: {
        architect: {
          role: 'architect',
          humanName: 'Gideon Park',
          workerIdentity: 'gideon-park-torghut-architect',
          tokenKey: 'HULY_API_TOKEN_GIDEON_PARK_TORGHUT_ARCHITECT',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_GIDEON_PARK_TORGHUT_ARCHITECT',
        },
        engineer: {
          role: 'engineer',
          humanName: 'Naomi Ibarra',
          workerIdentity: 'naomi-ibarra-torghut-engineer',
          tokenKey: 'HULY_API_TOKEN_NAOMI_IBARRA_TORGHUT_ENGINEER',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_NAOMI_IBARRA_TORGHUT_ENGINEER',
        },
        deployer: {
          role: 'deployer',
          humanName: 'Julian Hart',
          workerIdentity: 'julian-hart-torghut-deployer',
          tokenKey: 'HULY_API_TOKEN_JULIAN_HART_TORGHUT_DEPLOYER',
          expectedActorIdKey: 'HULY_EXPECTED_ACTOR_ID_JULIAN_HART_TORGHUT_DEPLOYER',
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
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
  return trimmed || 'swarm'
}

export const resolveDefaultWorkloadImage = () => {
  const candidate = resolveSupportingPrimitivesConfig(process.env).defaultWorkloadImage ?? ''
  return candidate.length > 0 ? candidate : null
}

export const parseStringList = (raw: unknown) => {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0)
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

const GLOBAL_HULY_SECRET = 'huly-api'

export const resolveSwarmRunSecrets = (existingSecrets: string[], explicitHulySecret?: string | null) => {
  const filtered = existingSecrets.filter((secret) => secret !== GLOBAL_HULY_SECRET)
  const explicit = explicitHulySecret?.trim()
  if (!explicit) return filtered
  return mergeUniqueStrings(filtered, [explicit])
}

const normalizeHulyBaseUrl = (value: string | null | undefined) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('huly://')) {
    return SWARM_DEFAULT_HULY_BASE_URL
  }
  try {
    const url = new URL(trimmed)
    if (!url.hostname.toLowerCase().includes('huly')) return ''
    if (url.hostname.toLowerCase().startsWith('front.')) {
      url.hostname = `transactor.${url.hostname.slice('front.'.length)}`
    }
    const origin = `${url.protocol}//${url.host}`
    return origin.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export const resolveSwarmHulyIntegration = (
  spec: Record<string, unknown>,
  owner: Record<string, unknown>,
  swarmName: string,
): SwarmHulyIntegration => {
  const integrations = asRecord(spec.integrations) ?? {}
  const huly = asRecord(integrations.huly) ?? {}
  const authSecretRef = asRecord(huly.authSecretRef) ?? {}
  const baseUrl = normalizeHulyBaseUrl(asString(huly.baseUrl)) || SWARM_DEFAULT_HULY_BASE_URL
  const secretName = asString(authSecretRef.name)?.trim() ?? ''
  const workspace = asString(huly.workspace)?.trim() || undefined
  const project = asString(huly.project)?.trim() || undefined
  const skillRef = asString(huly.skillRef)?.trim() || SWARM_DEFAULT_HULY_SKILL_REF
  const rawPersonas = asRecord(huly.personas) ?? {}
  const personaEntries = Object.entries(rawPersonas)
    .map(([role, value]) => {
      if (role !== 'architect' && role !== 'engineer' && role !== 'deployer') return null
      const record = asRecord(value) ?? {}
      return {
        role,
        humanName: asString(record.humanName)?.trim() ?? '',
        workerIdentity: asString(record.workerIdentity)?.trim() ?? '',
        tokenKey: asString(record.tokenKey)?.trim() ?? '',
        expectedActorIdKey: asString(record.expectedActorIdKey)?.trim() ?? '',
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
    baseUrl,
    workspace,
    project,
    secretName: secretName || defaultConfig?.secretName || '',
    skillRef,
    personas,
  }
}

export const resolveSwarmPersonaForStage = (huly: SwarmHulyIntegration, stage: StageName) => {
  return huly.personas[STAGE_PERSONA_ROLE[stage]]
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
    tokenKey: input.persona.tokenKey,
    expectedActorIdKey: input.persona.expectedActorIdKey,
  }
}

export const buildSwarmRuntimeParameters = (input: {
  ownerChannel: string | null
  huly: SwarmHulyIntegration
  identity: SwarmAgentIdentity
}) => {
  const parameters: Record<string, string> = {
    swarmAgentWorkerId: input.identity.workerId,
    swarmAgentIdentity: input.identity.identity,
    swarmAgentRole: input.identity.role,
    swarmHumanName: input.identity.humanName,
    swarmAgentTokenKey: input.identity.tokenKey,
    swarmAgentExpectedActorIdKey: input.identity.expectedActorIdKey,
    hulyApiBaseUrl: input.huly.baseUrl,
    hulySkillRef: input.huly.skillRef,
  }
  if (input.ownerChannel) parameters.ownerChannel = input.ownerChannel
  if (input.huly.workspace) parameters.hulyWorkspace = input.huly.workspace
  if (input.huly.project) parameters.hulyProject = input.huly.project
  return parameters
}

export const buildSwarmScheduleAnnotations = (input: {
  ownerChannel: string | null
  huly: SwarmHulyIntegration
  identity: SwarmAgentIdentity
}) => {
  const annotations: Record<string, string> = {
    [SWARM_SCHEDULE_ANNOTATION_WORKER_ID]: input.identity.workerId,
    [SWARM_SCHEDULE_ANNOTATION_IDENTITY]: input.identity.identity,
    [SWARM_SCHEDULE_ANNOTATION_ROLE]: input.identity.role,
    [SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME]: input.identity.humanName,
    [SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL]: input.huly.baseUrl,
    [SWARM_SCHEDULE_ANNOTATION_HULY_SECRET]: input.huly.secretName,
    [SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF]: input.huly.skillRef,
    [SWARM_SCHEDULE_ANNOTATION_HULY_TOKEN_KEY]: input.identity.tokenKey,
    [SWARM_SCHEDULE_ANNOTATION_HULY_EXPECTED_ACTOR_KEY]: input.identity.expectedActorIdKey,
  }
  if (input.ownerChannel) annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL] = input.ownerChannel
  if (input.huly.workspace) annotations[SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE] = input.huly.workspace
  if (input.huly.project) annotations[SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT] = input.huly.project
  return annotations
}

export const resolveScheduleRuntimeInjection = (schedule: Record<string, unknown>) => {
  const annotations = asRecord(schedule.metadata && asRecord(schedule.metadata)?.annotations) ?? {}
  const ownerChannel = asString(annotations[SWARM_SCHEDULE_ANNOTATION_OWNER_CHANNEL]) ?? null
  const workerId = asString(annotations[SWARM_SCHEDULE_ANNOTATION_WORKER_ID])
  const identity = asString(annotations[SWARM_SCHEDULE_ANNOTATION_IDENTITY])
  const role = asString(annotations[SWARM_SCHEDULE_ANNOTATION_ROLE])
  const humanName = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HUMAN_NAME])
  const hulyBaseUrl = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_BASE_URL])
  const hulyWorkspace = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_WORKSPACE])
  const hulyProject = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_PROJECT])
  const hulySecret = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_SECRET])
  const hulySkillRef = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_SKILL_REF])
  const hulyTokenKey = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_TOKEN_KEY])
  const hulyExpectedActorIdKey = asString(annotations[SWARM_SCHEDULE_ANNOTATION_HULY_EXPECTED_ACTOR_KEY])

  const parameters: Record<string, string> = {}
  if (ownerChannel) parameters.ownerChannel = ownerChannel
  if (workerId) parameters.swarmAgentWorkerId = workerId
  if (identity) parameters.swarmAgentIdentity = identity
  if (role) parameters.swarmAgentRole = role
  if (humanName) parameters.swarmHumanName = humanName
  if (hulyBaseUrl) parameters.hulyApiBaseUrl = hulyBaseUrl
  if (hulyWorkspace) parameters.hulyWorkspace = hulyWorkspace
  if (hulyProject) parameters.hulyProject = hulyProject
  if (hulySkillRef) parameters.hulySkillRef = hulySkillRef
  if (hulyTokenKey) parameters.swarmAgentTokenKey = hulyTokenKey
  if (hulyExpectedActorIdKey) parameters.swarmAgentExpectedActorIdKey = hulyExpectedActorIdKey

  return { parameters, hulySecret }
}
