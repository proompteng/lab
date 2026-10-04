import { z } from 'zod'

const actorIds = ['greg', 'ops', 'audit'] as const
const connectorIds = ['sql', 'rest', 'graphql', 'legacy', 'kubernetes', 'policy', 'audit'] as const

export type ActorId = (typeof actorIds)[number]
export type ConnectorKind = (typeof connectorIds)[number]
export type RuleMode = 'block' | 'approval' | 'audit'
export type RuleTarget = 'secret' | 'operation' | 'connector' | 'intent' | 'identity'
export type EventStatus =
  | 'received'
  | 'planned'
  | 'accepted'
  | 'allowed'
  | 'denied'
  | 'succeeded'
  | 'failed'
  | 'approval_required'
  | 'approved'
  | 'blocked'
export type Severity = 'info' | 'notice' | 'warning' | 'critical'
export type TaskStatus = 'received' | 'running' | 'waiting_approval' | 'blocked' | 'succeeded' | 'failed'
export type PlanStepStatus = 'pending' | 'allowed' | 'approval_required' | 'blocked' | 'succeeded' | 'failed'

export type EvidenceValue = string | number | boolean | null | EvidenceValue[] | { [key: string]: EvidenceValue }
export type EvidenceRecord = Record<string, EvidenceValue>

export type Actor = {
  id: ActorId
  name: string
  email: string
  role: string
  permissions: string[]
}

export type Connector = {
  id: ConnectorKind
  name: string
  target: string
  operations: string[]
  trustBoundary: string
  status: 'ready' | 'degraded'
}

export type GatewayEvent = {
  id: string
  timestamp: string
  taskId: string
  runId: string
  actorId: ActorId
  actorEmail: string
  actorRole: string
  connector: ConnectorKind
  operation: string
  target: string
  status: EventStatus
  severity: Severity
  summary: string
  policy: string
  requestHash: string
  correlationId: string
  durationMs: number
  evidence: EvidenceRecord
}

export type Approval = {
  id: string
  runId: string
  taskId?: string
  action: string
  target: string
  status: 'pending' | 'approved' | 'denied'
  reason: string
  requestedBy: ActorId
  approvedBy?: ActorId
  createdAt: string
  decidedAt?: string
}

export type GatewayRule = {
  id: string
  name: string
  mode: RuleMode
  target: RuleTarget
  pattern: string
  enabled: boolean
  source: 'system' | 'natural-language'
  createdBy: ActorId
  createdAt: string
  summary: string
  translatedFrom?: string
  translator?: 'codex-app-server' | 'deterministic'
}

export type GatewayTask = {
  id: string
  title: string
  intent: string
  requestedBy: ActorId
  actorEmail: string
  status: TaskStatus
  riskScore: number
  decision: EventStatus
  summary: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  approvalId?: string
  planStepIds: string[]
  connectorCallIds: string[]
}

export type PlanStep = {
  id: string
  taskId: string
  sequence: number
  connector: ConnectorKind
  operation: string
  target: string
  status: PlanStepStatus
  policy: string
  summary: string
  durationMs: number
  evidence: EvidenceRecord
}

export type ConnectorCall = {
  id: string
  taskId: string
  stepId: string
  connector: ConnectorKind
  operation: string
  target: string
  status: 'succeeded' | 'failed' | 'blocked'
  startedAt: string
  finishedAt: string
  durationMs: number
  inputHash: string
  evidence: EvidenceRecord
}

export type ActionDecision = 'pending' | 'allowed' | 'needs_approval' | 'blocked' | 'executed' | 'approved' | 'failed'

export type ActionEvidence = {
  summary: string
  target: string
  policy: string
  durationMs: number
}

export type AgentActionStep = {
  id: string
  runId: string
  sequence: number
  source: ConnectorKind
  sourceLabel: string
  action: string
  target: string
  decision: ActionDecision
  decisionLabel: string
  evidence: ActionEvidence
  approvalId?: string
}

export type AgentActionRun = {
  id: string
  title: string
  request: string
  requestedBy: string
  requesterRole: string
  createdAt: string
  updatedAt: string
  decision: ActionDecision
  decisionLabel: string
  riskScore: number
  sourceCount: number
  actionCount: number
  auditCount: number
  summary: string
  approvalId?: string
  approvalStatus?: Approval['status']
  steps: AgentActionStep[]
}

export type ProtectedAgentRun = {
  id: string
  name: string
  namespace: string
  agent: string
  status: 'blocked' | 'approval_required' | 'allowed'
  requestedAt: string
  riskScore: number
  requestedSecrets: string[]
  requestedConnectors: ConnectorKind[]
  requestedTools: string[]
  summary: string
  matchedRuleIds: string[]
  manifest: string
}

export type RuleMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  ruleId?: string
}

export type GatewaySnapshot = {
  actionRuns: AgentActionRun[]
  actors: Actor[]
  connectors: Connector[]
  events: GatewayEvent[]
  approvals: Approval[]
  rules: GatewayRule[]
  tasks: GatewayTask[]
  planSteps: PlanStep[]
  connectorCalls: ConnectorCall[]
  agentRuns: ProtectedAgentRun[]
  ruleMessages: RuleMessage[]
  stats: {
    totalEvents: number
    totalRules: number
    totalTasks: number
    totalAgentRuns: number
    awaitingApproval: number
    blockedAgentRuns: number
    connectorCount: number
    lastDecision: EventStatus | 'none'
  }
}

export type GatewayState = {
  sequence: number
  events: GatewayEvent[]
  approvals: Approval[]
  rules: GatewayRule[]
  tasks: GatewayTask[]
  planSteps: PlanStep[]
  connectorCalls: ConnectorCall[]
  agentRuns: ProtectedAgentRun[]
  ruleMessages: RuleMessage[]
}

export type AgentRunEvaluationInput = z.infer<typeof agentRunEvaluationSchema>
export type SnapshotFilters = z.infer<typeof snapshotInputSchema>
export type ApprovalInput = z.infer<typeof approvalSchema>
export type RuleBuilderInput = z.infer<typeof ruleBuilderSchema>
export type TaskIntakeInput = z.infer<typeof taskIntakeSchema>

export type RuleIntent = {
  name: string
  mode: RuleMode
  target: RuleTarget
  pattern: string
  summary?: string
  translator?: 'codex-app-server' | 'deterministic'
}

export type WorkflowContext = {
  database?: {
    source: 'postgres' | 'memory'
    tasks: number
    auditEvents: number
    approvals: number
    policies: number
    connectorCalls: number
  }
  liveAgentRuns?: AgentRunEvaluationInput[]
}

export const actors: Actor[] = [
  {
    id: 'greg',
    name: 'Greg Konush',
    email: 'greg@proompteng.ai',
    role: 'Security Operator',
    permissions: [
      'audit:read',
      'task:create',
      'workflow:execute',
      'rule:create',
      'agentrun:evaluate',
      'approval:approve',
    ],
  },
  {
    id: 'ops',
    name: 'Operations Approver',
    email: 'ops@proompteng.ai',
    role: 'Operations Approver',
    permissions: ['audit:read', 'task:create', 'workflow:execute', 'agentrun:evaluate', 'approval:approve'],
  },
  {
    id: 'audit',
    name: 'Audit Reader',
    email: 'audit@proompteng.ai',
    role: 'Audit Reader',
    permissions: ['audit:read'],
  },
]

export const connectors: Connector[] = [
  {
    id: 'sql',
    name: 'Internal SQL',
    target: 'postgresql://sag-db-rw.sag/sag',
    operations: ['read policy state', 'write task records', 'append audit events'],
    trustBoundary: 'CNPG application user scoped to SAG tables',
    status: 'ready',
  },
  {
    id: 'rest',
    name: 'Internal REST',
    target: 'https://kubernetes.default.svc/apis',
    operations: ['list AgentRuns', 'inspect Jobs', 'read cluster metadata'],
    trustBoundary: 'read-only service account scoped to AgentRun and Job metadata',
    status: 'ready',
  },
  {
    id: 'graphql',
    name: 'Audit GraphQL',
    target: '/api/internal/graphql',
    operations: ['query task graph', 'query audit trail', 'query connector calls'],
    trustBoundary: 'server-side graph over redacted persisted SAG records',
    status: 'ready',
  },
  {
    id: 'legacy',
    name: 'Legacy Interface',
    target: 'line-protocol://agentrun-job-status',
    operations: ['parse fixed-width records', 'normalize status feed', 'redact raw fields'],
    trustBoundary: 'read-only parser for legacy text feeds before data reaches the planner',
    status: 'ready',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes AgentRuns',
    target: 'agents.proompteng.ai/v1alpha1',
    operations: ['evaluate requested secrets', 'inspect runtime policy'],
    trustBoundary: 'policy gate runs before an AgentRun receives sensitive runtime authority',
    status: 'ready',
  },
  {
    id: 'policy',
    name: 'Policy Engine',
    target: 'sag.policy/rules',
    operations: ['translate rule', 'evaluate step', 'require approval', 'block unsafe access'],
    trustBoundary: 'deterministic policy executes before every connector action',
    status: 'ready',
  },
  {
    id: 'audit',
    name: 'Audit Stream',
    target: '/api/events/export',
    operations: ['append event', 'export JSONL', 'redact evidence'],
    trustBoundary: 'append-only event records with hashed inputs and redacted evidence',
    status: 'ready',
  },
]

const now = () => new Date().toISOString()

const globalForSag = globalThis as typeof globalThis & {
  __secureActionGatewayState?: GatewayState
}

const actorSchema = z.enum(actorIds)
const connectorSchema = z.enum(connectorIds)

const snapshotInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    connector: z.enum(['all', ...connectorIds]).default('all'),
    status: z
      .enum([
        'all',
        'received',
        'planned',
        'accepted',
        'allowed',
        'denied',
        'succeeded',
        'failed',
        'approval_required',
        'approved',
        'blocked',
      ])
      .default('all'),
  })
  .partial()
  .optional()

const approvalSchema = z.object({
  actorId: actorSchema,
  approvalId: z.string().min(1),
})

const ruleBuilderSchema = z.object({
  actorId: actorSchema,
  text: z.string().trim().min(8, 'Describe the rule in at least 8 characters').max(600),
})

const taskIntakeSchema = z.object({
  actorId: actorSchema,
  text: z.string().trim().min(8, 'Describe the task in at least 8 characters').max(1200),
})

const agentRunEvaluationSchema = z
  .object({
    actorId: actorSchema,
    name: z.string().trim().min(2).max(120).optional(),
    namespace: z.string().trim().min(1).max(80).optional(),
    agent: z.string().trim().min(1).max(120).optional(),
    requestedSecrets: z.array(z.string().trim().min(1).max(160)).max(24).optional(),
    requestedConnectors: z.array(connectorSchema).max(8).optional(),
    requestedTools: z.array(z.string().trim().min(1).max(160)).max(24).optional(),
    manifest: z.string().trim().max(8000).optional(),
  })
  .optional()

const defaultRules = (): GatewayRule[] => [
  {
    id: 'rule-secret-boundary',
    name: 'Block sensitive secrets',
    mode: 'block',
    target: 'secret',
    pattern: '(prod|production|payment|superuser|root|password|token|auth|credential)',
    enabled: true,
    source: 'system',
    createdBy: 'greg',
    createdAt: now(),
    summary: 'Block connector calls and AgentRuns that request sensitive secrets.',
  },
  {
    id: 'rule-mutation-approval',
    name: 'Approve mutating actions',
    mode: 'approval',
    target: 'operation',
    pattern: '(write|writeback|update|delete|execute|mutate|apply|merge|grant|revoke|restart|scale)',
    enabled: true,
    source: 'system',
    createdBy: 'greg',
    createdAt: now(),
    summary: 'Require an approved identity before any connector performs a mutating action.',
  },
]

const hashPayload = (value: unknown) => {
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const sensitiveKeyPattern = /(secret|token|password|credential|authorization|cookie|private.?key|auth)/i
const sensitiveValuePattern = /(sk-[a-z0-9_-]+|ghp_[a-z0-9_]+|password|secret|token|credential)/i

const redactName = (prefix: string, value: string) => `${prefix}:${hashPayload(value).slice(0, 10)}`

const redactUnknown = (value: unknown, key = ''): EvidenceValue => {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (sensitiveKeyPattern.test(key) || sensitiveValuePattern.test(value)) return redactName('secret', value)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, key))
  if (typeof value === 'object') {
    const output: Record<string, EvidenceValue> = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactUnknown(entryValue, entryKey)
    }
    return output
  }
  return String(value)
}

const redactEvidence = (value: Record<string, unknown>): EvidenceRecord => redactUnknown(value) as EvidenceRecord

const redactManifestSecretList = (manifest: string) => {
  try {
    const parsed = JSON.parse(manifest) as { spec?: { secrets?: unknown[] } }
    if (Array.isArray(parsed.spec?.secrets)) {
      parsed.spec.secrets = parsed.spec.secrets.map((secret) => redactUnknown(secret, 'secret'))
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return manifest.replace(sensitiveValuePattern, (match) => redactName('secret', match))
  }
}

const sanitizeAgentRun = (run: ProtectedAgentRun): ProtectedAgentRun => ({
  ...run,
  requestedSecrets: run.requestedSecrets.map((secret) =>
    secret.startsWith('secret:') ? secret : redactName('secret', secret),
  ),
  manifest: redactManifestSecretList(run.manifest),
})

const nextId = (state: GatewayState, prefix: string) => {
  state.sequence += 1
  return `${prefix}-${String(state.sequence).padStart(5, '0')}`
}

const safeRuleRegex = (rule: Pick<GatewayRule, 'pattern'>) => {
  try {
    return new RegExp(rule.pattern, 'i')
  } catch {
    return /$a/
  }
}

const hasPermission = (actor: Actor, permission: string) => actor.permissions.includes(permission)

export const findActor = (actorId: ActorId) => {
  const actor = actors.find((item) => item.id === actorId)
  if (!actor) throw new Error(`Unknown actor: ${actorId}`)
  return actor
}

export const isActorId = (value: unknown): value is ActorId => actorIds.includes(value as ActorId)

export const isConnectorKind = (value: unknown): value is ConnectorKind => connectorIds.includes(value as ConnectorKind)

export const resolveActorFromRequest = (request: Request) => {
  const forwardedEmail = request.headers.get('x-forwarded-email')?.trim().toLowerCase()
  const forwardedUser = request.headers.get('x-forwarded-user')?.trim().toLowerCase()
  const trustedActor = request.headers.get('x-sag-actor')?.trim().toLowerCase()
  const defaultActor = process.env.SAG_DEFAULT_ACTOR?.trim().toLowerCase()
  const candidate = trustedActor || forwardedEmail || forwardedUser || defaultActor || 'greg'
  const actor =
    actors.find((item) => item.id === candidate || item.email.toLowerCase() === candidate) ?? findActor('greg')
  return actor
}

export const createGatewayState = (): GatewayState => ({
  sequence: 0,
  events: [],
  approvals: [],
  rules: defaultRules(),
  tasks: [],
  planSteps: [],
  connectorCalls: [],
  agentRuns: [],
  ruleMessages: [],
})

const normalizeConnector = (value: unknown): ConnectorKind => {
  if (value === 'postgres') return 'sql'
  return isConnectorKind(value) ? value : 'audit'
}

const normalizeRuleTarget = (value: unknown): RuleTarget => {
  if (value === 'agentrun.secret') return 'secret'
  if (value === 'agentrun.connector') return 'connector'
  if (value === 'connector.action') return 'operation'
  if (value === 'prompt') return 'intent'
  if (
    value === 'secret' ||
    value === 'operation' ||
    value === 'connector' ||
    value === 'intent' ||
    value === 'identity'
  ) {
    return value
  }
  return 'intent'
}

const normalizeEvent = (event: Partial<GatewayEvent>): GatewayEvent => ({
  id: event.id ?? `evt-${hashPayload(event).slice(0, 8)}`,
  timestamp: event.timestamp ?? now(),
  taskId: event.taskId ?? event.runId ?? event.id ?? 'legacy',
  runId: event.runId ?? event.taskId ?? event.id ?? 'legacy',
  actorId: isActorId(event.actorId) ? event.actorId : 'greg',
  actorEmail: event.actorEmail ?? findActor('greg').email,
  actorRole: event.actorRole ?? findActor('greg').role,
  connector: normalizeConnector(event.connector),
  operation: event.operation ?? 'legacy.import',
  target: event.target ?? 'legacy',
  status: event.status ?? 'accepted',
  severity: event.severity ?? 'info',
  summary: event.summary ?? 'Imported legacy audit event.',
  policy: event.policy ?? 'legacy-import',
  requestHash: event.requestHash ?? hashPayload(event),
  correlationId: event.correlationId ?? `${event.runId ?? event.id ?? 'legacy'}:import`,
  durationMs: event.durationMs ?? 0,
  evidence: event.evidence ?? {},
})

const normalizeRule = (rule: Partial<GatewayRule>): GatewayRule => ({
  id: rule.id ?? `rule-${hashPayload(rule).slice(0, 8)}`,
  name: rule.name ?? 'Imported rule',
  mode: rule.mode === 'block' || rule.mode === 'approval' || rule.mode === 'audit' ? rule.mode : 'audit',
  target: normalizeRuleTarget(rule.target),
  pattern: rule.pattern ?? '.*',
  enabled: rule.enabled ?? true,
  source: rule.source === 'natural-language' ? 'natural-language' : 'system',
  createdBy: isActorId(rule.createdBy) ? rule.createdBy : 'greg',
  createdAt: rule.createdAt ?? now(),
  summary: rule.summary ?? 'Imported legacy rule.',
  translatedFrom: rule.translatedFrom,
  translator: rule.translator,
})

const normalizeAgentRun = (run: Partial<ProtectedAgentRun>): ProtectedAgentRun => ({
  id: run.id ?? `arun-${hashPayload(run).slice(0, 8)}`,
  name: run.name ?? 'agentrun',
  namespace: run.namespace ?? 'agents',
  agent: run.agent ?? 'agent',
  status:
    run.status === 'blocked' || run.status === 'approval_required' || run.status === 'allowed' ? run.status : 'allowed',
  requestedAt: run.requestedAt ?? now(),
  riskScore: run.riskScore ?? 0,
  requestedSecrets: run.requestedSecrets ?? [],
  requestedConnectors: (run.requestedConnectors ?? []).map(normalizeConnector),
  requestedTools: run.requestedTools ?? [],
  summary: run.summary ?? 'Imported AgentRun evaluation.',
  matchedRuleIds: run.matchedRuleIds ?? [],
  manifest: run.manifest ?? '{}',
})

export const normalizeGatewayState = (value: Partial<GatewayState> | null | undefined): GatewayState => ({
  sequence: Number(value?.sequence ?? 0),
  events: (value?.events ?? []).map(normalizeEvent),
  approvals: value?.approvals ?? [],
  rules: value?.rules?.length ? value.rules.map(normalizeRule) : defaultRules(),
  tasks: value?.tasks ?? [],
  planSteps: value?.planSteps ?? [],
  connectorCalls: value?.connectorCalls ?? [],
  agentRuns: (value?.agentRuns ?? []).map(normalizeAgentRun),
  ruleMessages: value?.ruleMessages ?? [],
})

export const getGatewayState = () => {
  globalForSag.__secureActionGatewayState ??= createGatewayState()
  return globalForSag.__secureActionGatewayState
}

export const resetGatewayState = () => {
  const state = createGatewayState()
  globalForSag.__secureActionGatewayState = state
  return state
}

export const replaceGatewayState = (state: GatewayState) => {
  globalForSag.__secureActionGatewayState = normalizeGatewayState(state)
  return globalForSag.__secureActionGatewayState
}

export const createEmptyGatewaySnapshot = () => buildSnapshot(createGatewayState())

const appendEvent = (
  state: GatewayState,
  input: Omit<GatewayEvent, 'id' | 'timestamp' | 'requestHash' | 'correlationId' | 'evidence'> & {
    request?: unknown
    evidence: Record<string, unknown>
  },
) => {
  const { request, evidence, ...eventInput } = input
  const event: GatewayEvent = {
    ...eventInput,
    evidence: redactEvidence(evidence),
    id: nextId(state, 'evt'),
    timestamp: now(),
    requestHash: hashPayload(request ?? evidence),
    correlationId: `${input.taskId}:${state.sequence + 1}`,
  }
  state.events.unshift(event)
  return event
}

const summarizeRule = (rule: Pick<GatewayRule, 'mode' | 'target' | 'pattern'>) => {
  if (rule.mode === 'block') return `Block ${rule.target} when it matches ${rule.pattern}.`
  if (rule.mode === 'approval') return `Require approval when ${rule.target} matches ${rule.pattern}.`
  return `Audit ${rule.target} when it matches ${rule.pattern}.`
}

const ruleName = (mode: RuleMode, target: RuleTarget) => {
  if (mode === 'block' && target === 'secret') return 'Block sensitive secrets'
  if (mode === 'approval' && target === 'operation') return 'Approve mutating operations'
  if (target === 'connector') return 'Control connector access'
  return 'Audit matching intent'
}

export const parseRuleIntent = (text: string): RuleIntent => {
  const mentionsSecret = /\b(secret|token|password|credential|key|auth)\b/i.test(text)
  const mentionsConnector = /\b(sql|postgres|database|rest|api|graphql|legacy|connector|tool)\b/i.test(text)
  const asksApproval = /\b(approval|approve|review|human|hold|allow)\b/i.test(text)
  const asksBlock = /\b(block|deny|stop|prevent|disallow|never)\b/i.test(text)

  if (mentionsSecret) {
    const mode: RuleMode = asksBlock ? 'block' : asksApproval ? 'approval' : 'audit'
    return {
      name: ruleName(mode, 'secret'),
      mode,
      target: 'secret',
      pattern: '(prod|production|payment|superuser|root|password|token|auth|credential)',
      translator: 'deterministic',
    }
  }

  if (asksApproval || /\b(write|delete|update|execute|apply|merge|grant|revoke|restart|scale)\b/i.test(text)) {
    return {
      name: ruleName('approval', 'operation'),
      mode: 'approval',
      target: 'operation',
      pattern: '(write|writeback|update|delete|execute|mutate|apply|merge|grant|revoke|restart|scale)',
      translator: 'deterministic',
    }
  }

  if (mentionsConnector) {
    return {
      name: ruleName(asksBlock ? 'block' : 'audit', 'connector'),
      mode: asksBlock ? 'block' : 'audit',
      target: 'connector',
      pattern: '(sql|postgres|database|rest|api|graphql|legacy)',
      translator: 'deterministic',
    }
  }

  const pattern = text
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('|')

  return {
    name: 'Audit matching intent',
    mode: 'audit',
    target: 'intent',
    pattern,
    translator: 'deterministic',
  }
}

export const createRuleFromText = (state: GatewayState, input: RuleBuilderInput, translated?: RuleIntent | null) => {
  const parsedInput = ruleBuilderSchema.parse(input)
  const actor = findActor(parsedInput.actorId)
  if (!hasPermission(actor, 'rule:create')) {
    throw new Error(`${actor.role} cannot create rules`)
  }

  const parsed = translated ?? parseRuleIntent(parsedInput.text)
  const rule: GatewayRule = {
    id: nextId(state, 'rule'),
    name: parsed.name,
    mode: parsed.mode,
    target: parsed.target,
    pattern: parsed.pattern,
    enabled: true,
    source: 'natural-language',
    createdBy: actor.id,
    createdAt: now(),
    summary: parsed.summary ?? summarizeRule(parsed),
    translatedFrom: parsedInput.text,
    translator: parsed.translator ?? 'deterministic',
  }
  state.rules.unshift(rule)
  state.ruleMessages.unshift(
    {
      id: nextId(state, 'msg'),
      role: 'assistant',
      content: `${rule.name}: ${rule.summary}`,
      createdAt: now(),
      ruleId: rule.id,
    },
    {
      id: nextId(state, 'msg'),
      role: 'user',
      content: parsedInput.text,
      createdAt: now(),
    },
  )

  appendEvent(state, {
    taskId: rule.id,
    runId: rule.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'policy',
    operation: 'rule:create',
    target: rule.target,
    status: 'accepted',
    severity: 'notice',
    summary: rule.summary,
    policy: 'natural-language-rule-builder-v2',
    durationMs: 12,
    evidence: {
      ruleId: rule.id,
      mode: rule.mode,
      pattern: rule.pattern,
      source: rule.source,
      translator: rule.translator ?? 'deterministic',
    },
    request: parsedInput,
  })
  return rule
}

const containsMutation = (text: string) =>
  /\b(write|writeback|update|delete|execute|mutate|apply|merge|grant|revoke|restart|scale|approve|release)\b/i.test(
    text,
  )

const extractSecrets = (text: string) => {
  const matches = text.match(/\b[\w.-]*(?:secret|token|password|credential|auth)[\w.-]*\b/gi) ?? []
  return Array.from(new Set(matches))
}

const makeTaskTitle = (text: string) => {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= 72) return compact
  return `${compact.slice(0, 69)}...`
}

const planForIntent = (state: GatewayState, task: GatewayTask): PlanStep[] => {
  const mutating = containsMutation(task.intent)
  const base: Array<Omit<PlanStep, 'id' | 'taskId' | 'status' | 'policy' | 'durationMs' | 'evidence'>> = [
    {
      sequence: 1,
      connector: 'sql',
      operation: 'policy_context.read',
      target: 'sag.sql/policy-state',
      summary: 'Read persisted policy and audit context.',
    },
    {
      sequence: 2,
      connector: 'rest',
      operation: 'agentruns.list',
      target: 'kubernetes/apis/agents.proompteng.ai/v1alpha1',
      summary: 'Read live AgentRun workload state through the Kubernetes API.',
    },
    {
      sequence: 3,
      connector: 'graphql',
      operation: 'audit_graph.query',
      target: 'sag.graphql/task-audit',
      summary: 'Query the task and audit graph for current evidence.',
    },
    {
      sequence: 4,
      connector: 'legacy',
      operation: 'legacy_status.parse',
      target: 'line-protocol://agentrun-job-status',
      summary: 'Parse a legacy line-oriented status feed.',
    },
  ]

  if (mutating) {
    base.push({
      sequence: 5,
      connector: 'rest',
      operation: 'guarded_action.execute',
      target: 'kubernetes/apis/guarded-action',
      summary: 'Release the requested mutating action after policy approval.',
    })
  }

  return base.map((step) => ({
    ...step,
    id: nextId(state, 'step'),
    taskId: task.id,
    status: 'pending',
    policy: 'pending',
    durationMs: 0,
    evidence: {},
  }))
}

const matchesRule = (
  rule: GatewayRule,
  input: { intent: string; connector: ConnectorKind; operation: string; target: string; secrets: string[] },
) => {
  if (!rule.enabled) return false
  const regex = safeRuleRegex(rule)
  if (rule.target === 'secret') return input.secrets.some((secret) => regex.test(secret))
  if (rule.target === 'operation') return regex.test(input.operation) || regex.test(input.target)
  if (rule.target === 'connector') return regex.test(input.connector)
  if (rule.target === 'identity') return false
  return regex.test(input.intent)
}

const evaluatePlanStepPolicy = (
  state: GatewayState,
  actor: Actor,
  task: GatewayTask,
  step: PlanStep,
): { status: 'allowed' | 'approval_required' | 'blocked'; rules: GatewayRule[]; policy: string } => {
  const matchedRules = state.rules.filter((rule) =>
    matchesRule(rule, {
      intent: task.intent,
      connector: step.connector,
      operation: step.operation,
      target: step.target,
      secrets: extractSecrets(task.intent),
    }),
  )
  const blocking = matchedRules.filter((rule) => rule.mode === 'block')
  if (blocking.length > 0)
    return { status: 'blocked', rules: blocking, policy: blocking.map((rule) => rule.id).join(',') }

  const requiresApproval = matchedRules.filter((rule) => rule.mode === 'approval')
  if (requiresApproval.length > 0) {
    return {
      status: 'approval_required',
      rules: requiresApproval,
      policy: requiresApproval.map((rule) => rule.id).join(','),
    }
  }

  if (!hasPermission(actor, 'workflow:execute')) {
    return { status: 'blocked', rules: [], policy: 'identity-rbac-v1' }
  }

  return {
    status: 'allowed',
    rules: matchedRules,
    policy: matchedRules.map((rule) => rule.id).join(',') || 'no-rule-match',
  }
}

const connectorEvidence = (state: GatewayState, step: PlanStep, context: WorkflowContext = {}): EvidenceRecord => {
  if (step.connector === 'sql') {
    const db = context.database ?? {
      source: 'memory' as const,
      tasks: state.tasks.length,
      auditEvents: state.events.length,
      approvals: state.approvals.length,
      policies: state.rules.length,
      connectorCalls: state.connectorCalls.length,
    }
    return redactEvidence({
      source: db.source,
      tasks: db.tasks,
      auditEvents: db.auditEvents,
      approvals: db.approvals,
      policies: db.policies,
      connectorCalls: db.connectorCalls,
    })
  }

  if (step.connector === 'rest') {
    const live = context.liveAgentRuns ?? []
    return redactEvidence({
      api: 'kubernetes',
      liveAgentRuns: live.length,
      protectedWithSecrets: live.filter((run) => (run?.requestedSecrets?.length ?? 0) > 0).length,
      latest: live.slice(0, 5).map((run) => ({
        name: run?.name ?? 'agentrun',
        namespace: run?.namespace ?? 'agents',
        agent: run?.agent ?? 'agent',
        requestedSecrets: run?.requestedSecrets ?? [],
      })),
    })
  }

  if (step.connector === 'graphql') {
    const byConnector = connectors.reduce<Record<string, number>>((accumulator, connector) => {
      accumulator[connector.id] = state.events.filter((event) => event.connector === connector.id).length
      return accumulator
    }, {})
    return redactEvidence({
      graph: 'task-audit',
      nodes: state.tasks.length + state.planSteps.length + state.connectorCalls.length + state.events.length,
      tasks: state.tasks.length,
      connectorCalls: state.connectorCalls.length,
      eventsByConnector: byConnector,
    })
  }

  if (step.connector === 'legacy') {
    const lines = (context.liveAgentRuns ?? [])
      .slice(0, 8)
      .map((run, index) =>
        [
          String(index + 1).padStart(3, '0'),
          run?.namespace ?? 'agents',
          run?.name ?? 'agentrun',
          run?.agent ?? 'agent',
          String(run?.requestedSecrets?.length ?? 0),
        ].join('|'),
      )
    return redactEvidence({
      format: 'pipe-delimited',
      linesParsed: lines.length,
      records: lines.map((line) => {
        const [ordinal, namespace, name, agent, secretCount] = line.split('|')
        return { ordinal, namespace, name, agent, secretCount: Number(secretCount ?? 0) }
      }),
    })
  }

  return redactEvidence({ connector: step.connector, status: 'ready' })
}

const executeAllowedStep = (
  state: GatewayState,
  actor: Actor,
  task: GatewayTask,
  step: PlanStep,
  context: WorkflowContext,
) => {
  const startedAt = now()
  const durationMs = step.connector === 'rest' ? 29 : step.connector === 'sql' ? 11 : 7
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString()
  const evidence = connectorEvidence(state, step, context)
  const call: ConnectorCall = {
    id: nextId(state, 'call'),
    taskId: task.id,
    stepId: step.id,
    connector: step.connector,
    operation: step.operation,
    target: step.target,
    status: 'succeeded',
    startedAt,
    finishedAt,
    durationMs,
    inputHash: hashPayload({ task: task.intent, step }),
    evidence,
  }
  state.connectorCalls.unshift(call)
  task.connectorCallIds.push(call.id)
  step.status = 'succeeded'
  step.durationMs = durationMs
  step.evidence = evidence

  appendEvent(state, {
    taskId: task.id,
    runId: step.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: step.connector,
    operation: step.operation,
    target: step.target,
    status: 'succeeded',
    severity: 'notice',
    summary: step.summary,
    policy: step.policy,
    durationMs,
    evidence: {
      callId: call.id,
      evidence,
    },
    request: { task: task.intent, step },
  })
}

export const createTaskFromText = (state: GatewayState, input: TaskIntakeInput, context: WorkflowContext = {}) => {
  const parsed = taskIntakeSchema.parse(input)
  const actor = findActor(parsed.actorId)
  if (!hasPermission(actor, 'task:create')) {
    throw new Error(`${actor.role} cannot create tasks`)
  }

  const task: GatewayTask = {
    id: nextId(state, 'task'),
    title: makeTaskTitle(parsed.text),
    intent: parsed.text,
    requestedBy: actor.id,
    actorEmail: actor.email,
    status: 'running',
    riskScore: Math.min(100, extractSecrets(parsed.text).length * 25 + (containsMutation(parsed.text) ? 35 : 8)),
    decision: 'planned',
    summary: 'Planning connector actions.',
    createdAt: now(),
    updatedAt: now(),
    planStepIds: [],
    connectorCallIds: [],
  }
  state.tasks.unshift(task)

  appendEvent(state, {
    taskId: task.id,
    runId: task.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'audit',
    operation: 'task:intake',
    target: 'natural-language',
    status: 'received',
    severity: 'info',
    summary: 'Received natural-language operational intent.',
    policy: 'identity-rbac-v1',
    durationMs: 3,
    evidence: { riskScore: task.riskScore },
    request: parsed,
  })

  const steps = planForIntent(state, task)
  state.planSteps.unshift(...[...steps].reverse())
  task.planStepIds.push(...steps.map((step) => step.id))

  appendEvent(state, {
    taskId: task.id,
    runId: task.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'policy',
    operation: 'task:plan',
    target: 'connector-plan',
    status: 'planned',
    severity: 'info',
    summary: `Planned ${steps.length} connector steps.`,
    policy: 'connector-plan-v1',
    durationMs: 5,
    evidence: {
      steps: steps.map((step) => ({ connector: step.connector, operation: step.operation, target: step.target })),
    },
    request: parsed,
  })

  for (const step of steps) {
    const decision = evaluatePlanStepPolicy(state, actor, task, step)
    step.policy = decision.policy
    step.status = decision.status

    if (decision.status === 'blocked') {
      task.status = 'blocked'
      task.decision = 'blocked'
      task.summary = `Blocked before ${step.operation}.`
      task.updatedAt = now()
      task.completedAt = task.updatedAt
      appendEvent(state, {
        taskId: task.id,
        runId: step.id,
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        connector: 'policy',
        operation: 'policy:block',
        target: step.target,
        status: 'blocked',
        severity: 'critical',
        summary: task.summary,
        policy: decision.policy,
        durationMs: 4,
        evidence: { matchedRules: decision.rules.map((rule) => rule.id), stepId: step.id },
        request: { task: parsed.text, step },
      })
      return task
    }

    if (decision.status === 'approval_required') {
      const approval: Approval = {
        id: nextId(state, 'appr'),
        taskId: task.id,
        runId: step.id,
        action: step.operation,
        target: step.target,
        status: 'pending',
        reason: 'Policy requires approval before this connector action can execute.',
        requestedBy: actor.id,
        createdAt: now(),
      }
      state.approvals.unshift(approval)
      task.status = 'waiting_approval'
      task.decision = 'approval_required'
      task.approvalId = approval.id
      task.summary = `Waiting for approval before ${step.operation}.`
      task.updatedAt = now()
      appendEvent(state, {
        taskId: task.id,
        runId: step.id,
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role,
        connector: 'policy',
        operation: 'approval:request',
        target: step.target,
        status: 'approval_required',
        severity: 'warning',
        summary: task.summary,
        policy: decision.policy,
        durationMs: 5,
        evidence: { approvalId: approval.id, matchedRules: decision.rules.map((rule) => rule.id), stepId: step.id },
        request: { task: parsed.text, step },
      })
      return task
    }

    executeAllowedStep(state, actor, task, step, context)
  }

  task.status = 'succeeded'
  task.decision = 'succeeded'
  task.summary = 'Completed guarded connector plan.'
  task.updatedAt = now()
  task.completedAt = task.updatedAt
  return task
}

export const approveAction = (state: GatewayState, input: ApprovalInput) => {
  const parsed = approvalSchema.parse(input)
  const actor = findActor(parsed.actorId)
  const approval = state.approvals.find((item) => item.id === parsed.approvalId)
  if (!approval) throw new Error(`Approval not found: ${parsed.approvalId}`)

  if (!hasPermission(actor, 'approval:approve')) {
    appendEvent(state, {
      taskId: approval.taskId ?? approval.runId,
      runId: approval.runId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      connector: 'policy',
      operation: 'approval:approve',
      target: approval.target,
      status: 'denied',
      severity: 'critical',
      summary: `${actor.role} cannot approve this action.`,
      policy: 'approval-rbac-v1',
      durationMs: 4,
      evidence: { approvalId: approval.id, decision: 'deny', permission: 'approval:approve' },
      request: parsed,
    })
    return { ok: false as const, message: 'Actor is not allowed to approve this action' }
  }

  if (approval.status !== 'pending') {
    return { ok: false as const, message: `Approval is already ${approval.status}` }
  }

  approval.status = 'approved'
  approval.approvedBy = actor.id
  approval.decidedAt = now()
  const agentRun = state.agentRuns.find((item) => item.id === approval.runId)
  if (agentRun) {
    agentRun.status = 'allowed'
    agentRun.summary = `${agentRun.name} approved for guarded execution`
  }
  const task = approval.taskId ? state.tasks.find((item) => item.id === approval.taskId) : null
  if (task) {
    task.status = 'succeeded'
    task.decision = 'approved'
    task.summary = `Approved ${approval.action}.`
    task.updatedAt = now()
    task.completedAt = task.updatedAt
  }

  appendEvent(state, {
    taskId: approval.taskId ?? approval.runId,
    runId: approval.runId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'policy',
    operation: 'approval:approve',
    target: approval.target,
    status: 'approved',
    severity: 'notice',
    summary: `Approved ${approval.action}.`,
    policy: 'approval-rbac-v1',
    durationMs: 7,
    evidence: { approvalId: approval.id, decision: 'approve' },
    request: parsed,
  })
  return { ok: true as const, task, agentRun }
}

export const requestDatabaseAccessApproval = (
  state: GatewayState,
  input: { actorId: ActorId; namespace: string; runName: string },
) => {
  const actor = findActor(input.actorId)
  const target = `${input.namespace}/${input.runName}:sag.database.tables`
  const existing = state.approvals.find(
    (approval) =>
      approval.action === 'database.list_tables' &&
      approval.target === target &&
      (approval.status === 'pending' || approval.status === 'approved'),
  )
  if (existing) return existing

  const protectedRun = state.agentRuns.find((run) => run.namespace === input.namespace && run.name === input.runName)
  const approval: Approval = {
    id: nextId(state, 'appr'),
    runId: protectedRun?.id ?? `agentrun:${input.namespace}/${input.runName}`,
    action: 'database.list_tables',
    target,
    status: 'pending',
    reason: 'AgentRun requested permission to inspect SAG database tables.',
    requestedBy: actor.id,
    createdAt: now(),
  }
  state.approvals.unshift(approval)
  appendEvent(state, {
    taskId: approval.runId,
    runId: approval.runId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'sql',
    operation: 'database:list_tables',
    target,
    status: 'approval_required',
    severity: 'warning',
    summary: 'Database table inspection is waiting for approval.',
    policy: 'database-access-approval',
    durationMs: 3,
    evidence: {
      approvalId: approval.id,
      namespace: input.namespace,
      runName: input.runName,
      database: 'sag',
      operation: 'list_tables',
    },
    request: input,
  })
  return approval
}

const defaultAgentRunRequest = (input?: AgentRunEvaluationInput) => ({
  actorId: input?.actorId ?? 'greg',
  name: input?.name ?? 'live-agentrun',
  namespace: input?.namespace ?? 'agents',
  agent: input?.agent ?? 'agent',
  requestedSecrets: input?.requestedSecrets ?? [],
  requestedConnectors: input?.requestedConnectors ?? (['kubernetes'] satisfies ConnectorKind[]),
  requestedTools: input?.requestedTools ?? [],
  manifest: input?.manifest,
})

const agentRunManifest = (request: ReturnType<typeof defaultAgentRunRequest>) => {
  const secretLines = request.requestedSecrets.map((secret) => `    - name: ${redactName('secret', secret)}`).join('\n')
  return `apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: ${request.name}
  namespace: ${request.namespace}
spec:
  agentRef:
    name: ${request.agent}
  secrets:
${secretLines}
`
}

export const evaluateAgentRun = (state: GatewayState, input?: AgentRunEvaluationInput) => {
  const request = defaultAgentRunRequest(input)
  const actor = findActor(request.actorId)
  const activeRules = state.rules.filter((rule) => rule.enabled)
  const matchedRules = activeRules.filter((rule) => {
    const regex = safeRuleRegex(rule)
    if (rule.target === 'secret') return request.requestedSecrets.some((secret) => regex.test(secret))
    if (rule.target === 'connector') return request.requestedConnectors.some((connector) => regex.test(connector))
    if (rule.target === 'operation') return request.requestedTools.some((tool) => regex.test(tool))
    return regex.test(request.manifest ?? agentRunManifest(request))
  })
  const blockingRules = matchedRules.filter((rule) => rule.mode === 'block')
  const approvalRules = matchedRules.filter((rule) => rule.mode === 'approval')
  let status: ProtectedAgentRun['status'] = 'allowed'
  if (blockingRules.length > 0) status = 'blocked'
  else if (approvalRules.length > 0) status = 'approval_required'

  const riskScore = Math.min(99, request.requestedSecrets.length * 20 + request.requestedTools.length * 9)
  const protectedRun: ProtectedAgentRun = {
    id: nextId(state, 'arun'),
    name: request.name,
    namespace: request.namespace,
    agent: request.agent,
    status,
    requestedAt: now(),
    riskScore,
    requestedSecrets: request.requestedSecrets.map((secret) => redactName('secret', secret)),
    requestedConnectors: request.requestedConnectors,
    requestedTools: request.requestedTools,
    summary: statusSummary(status, request.name),
    matchedRuleIds: matchedRules.map((rule) => rule.id),
    manifest: request.manifest ? redactManifestSecretList(request.manifest) : agentRunManifest(request),
  }
  state.agentRuns.unshift(protectedRun)

  if (status === 'approval_required') {
    state.approvals.unshift({
      id: nextId(state, 'appr'),
      runId: protectedRun.id,
      action: 'agentrun.execute',
      target: `${protectedRun.namespace}/${protectedRun.name}`,
      status: 'pending',
      reason: 'Matched approval rule before guarded execution.',
      requestedBy: actor.id,
      createdAt: now(),
    })
  }

  appendEvent(state, {
    taskId: protectedRun.id,
    runId: protectedRun.id,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'kubernetes',
    operation: 'agentrun:evaluate',
    target: `${protectedRun.namespace}/${protectedRun.name}`,
    status,
    severity: status === 'blocked' ? 'critical' : status === 'approval_required' ? 'warning' : 'notice',
    summary: protectedRun.summary,
    policy: matchedRules.map((rule) => rule.id).join(',') || 'no-rule-match',
    durationMs: 16,
    evidence: {
      agent: protectedRun.agent,
      riskScore,
      matchedRules: protectedRun.matchedRuleIds,
      requestedConnectors: protectedRun.requestedConnectors,
      requestedSecretCount: request.requestedSecrets.length,
      requestedSecretHashes: protectedRun.requestedSecrets,
    },
    request,
  })

  return protectedRun
}

const statusSummary = (status: ProtectedAgentRun['status'], name: string) => {
  if (status === 'blocked') return `Blocked ${name} before sensitive runtime authority was attached.`
  if (status === 'approval_required') return `Held ${name} for approval.`
  return `Allowed ${name} with audit capture.`
}

const displayText = (value: string) =>
  value
    .replaceAll('AgentRuns', 'protected workloads')
    .replaceAll('AgentRun', 'protected workload')
    .replaceAll('SQL policy state', 'policy data')
    .replaceAll('SQL', 'policy data')
    .replaceAll('REST', 'workload API')
    .replaceAll('GraphQL', 'audit graph')
    .replaceAll('legacy feed', 'operations feed')
    .replaceAll('legacy line-oriented status feed', 'operations status feed')
    .replaceAll('connector', 'source')

const actionSourceLabel = (value: ConnectorKind) => {
  const labels: Record<ConnectorKind, string> = {
    sql: 'Policy data',
    rest: 'Workload API',
    graphql: 'Audit graph',
    legacy: 'Ops feed',
    kubernetes: 'Workload control',
    policy: 'Policy gate',
    audit: 'Audit log',
  }
  return labels[value]
}

const actionOperationLabel = (value: string) => {
  const labels: Record<string, string> = {
    'policy_context.read': 'Read current policy',
    'agentruns.list': 'Inspect workloads',
    'audit_graph.query': 'Reconcile audit',
    'legacy_status.parse': 'Parse ops feed',
    'guarded_action.execute': 'Execute change',
    'task:intake': 'Receive request',
    'task:plan': 'Plan actions',
    'approval:request': 'Hold for approval',
    'approval:approve': 'Release action',
    'policy:block': 'Block action',
    'rule:create': 'Create policy',
    'agentrun:evaluate': 'Evaluate workload',
    'legacy.import': 'Import event',
  }
  return labels[value] ?? displayText(value)
}

const actionPolicyLabel = (value: string) => {
  if (value === 'no-rule-match') return 'Clear'
  if (value === 'identity-rbac-v1') return 'Identity'
  if (value === 'connector-plan-v1') return 'Plan'
  if (value === 'approval-rbac-v1') return 'Approval'
  if (value === 'natural-language-rule-builder-v2') return 'Created'
  if (value.includes(',')) return `${value.split(',').filter(Boolean).length} policies`
  if (value.startsWith('rule-')) return 'Policy'
  return displayText(value)
}

const actionTargetLabel = (value: string) => {
  if (value.includes('sag.sql')) return 'Policy store'
  if (value.includes('guarded-action')) return 'Workload controller'
  if (value.includes('kubernetes/apis') || value.includes('agents.proompteng.ai')) return 'Workload API'
  if (value.includes('sag.graphql')) return 'Audit graph'
  if (value.includes('line-protocol')) return 'Ops feed'
  if (value.includes('/api/events/export')) return 'Audit export'
  if (value.startsWith('postgresql://')) return 'Policy store'
  if (value.startsWith('/api/internal/graphql')) return 'Audit graph'
  return displayText(value)
}

const actionDecisionLabel = (value: ActionDecision) => {
  const labels: Record<ActionDecision, string> = {
    pending: 'Pending',
    allowed: 'Allowed',
    needs_approval: 'Needs approval',
    blocked: 'Blocked',
    executed: 'Executed',
    approved: 'Approved',
    failed: 'Failed',
  }
  return labels[value]
}

const taskDecision = (task: GatewayTask): ActionDecision => {
  if (task.decision === 'approval_required' || task.status === 'waiting_approval') return 'needs_approval'
  if (task.decision === 'approved') return 'approved'
  if (task.decision === 'blocked' || task.status === 'blocked') return 'blocked'
  if (task.decision === 'failed' || task.status === 'failed') return 'failed'
  if (task.decision === 'succeeded' || task.status === 'succeeded') return 'executed'
  if (task.decision === 'planned' || task.status === 'running') return 'pending'
  return 'allowed'
}

const stepDecision = (
  step: PlanStep,
  call: ConnectorCall | undefined,
  approval: Approval | undefined,
): ActionDecision => {
  if (approval?.status === 'approved') return 'approved'
  if (approval?.status === 'pending' || step.status === 'approval_required') return 'needs_approval'
  if (step.status === 'blocked' || call?.status === 'blocked') return 'blocked'
  if (step.status === 'failed' || call?.status === 'failed') return 'failed'
  if (call?.status === 'succeeded' || step.status === 'succeeded') return 'executed'
  if (step.status === 'allowed') return 'allowed'
  return 'pending'
}

const callEvidenceSummary = (call: ConnectorCall | undefined, step: PlanStep) => {
  if (!call) {
    if (step.status === 'approval_required') return 'Waiting for approval.'
    if (step.status === 'blocked') return 'Stopped before execution.'
    return 'Ready.'
  }

  const evidence = call.evidence
  const liveWorkloads = typeof evidence.liveAgentRuns === 'number' ? evidence.liveAgentRuns : null
  const protectedWithSecrets = typeof evidence.protectedWithSecrets === 'number' ? evidence.protectedWithSecrets : null
  const linesParsed = typeof evidence.linesParsed === 'number' ? evidence.linesParsed : null
  const nodes = typeof evidence.nodes === 'number' ? evidence.nodes : null
  const tasks = typeof evidence.tasks === 'number' ? evidence.tasks : null
  const auditEvents = typeof evidence.auditEvents === 'number' ? evidence.auditEvents : null

  if (call.connector === 'rest' && liveWorkloads !== null) {
    return `${liveWorkloads} workloads inspected, ${protectedWithSecrets ?? 0} sensitive.`
  }
  if (call.connector === 'legacy' && linesParsed !== null) return `${linesParsed} ops records normalized.`
  if (call.connector === 'graphql' && nodes !== null) return `${nodes} audit nodes reconciled.`
  if (call.connector === 'sql' && tasks !== null) return `${tasks} requests, ${auditEvents ?? 0} audit events.`
  return `${actionOperationLabel(call.operation)} completed.`
}

const buildActionRuns = (state: GatewayState): AgentActionRun[] =>
  state.tasks.map((task) => {
    const steps = state.planSteps
      .filter((step) => step.taskId === task.id)
      .sort((left, right) => left.sequence - right.sequence)
    const events = state.events.filter((event) => event.taskId === task.id)
    const taskApproval = state.approvals.find((approval) => approval.taskId === task.id)
    const sources = new Set(steps.map((step) => step.connector))

    const actionSteps: AgentActionStep[] = steps.map((step) => {
      const call = state.connectorCalls.find((item) => item.stepId === step.id)
      const approval = state.approvals.find((item) => item.runId === step.id)
      const decision = stepDecision(step, call, approval)
      return {
        id: step.id,
        runId: task.id,
        sequence: step.sequence,
        source: step.connector,
        sourceLabel: actionSourceLabel(step.connector),
        action: actionOperationLabel(step.operation),
        target: actionTargetLabel(step.target),
        decision,
        decisionLabel: actionDecisionLabel(decision),
        evidence: {
          summary: callEvidenceSummary(call, step),
          target: actionTargetLabel(call?.target ?? step.target),
          policy: actionPolicyLabel(step.policy),
          durationMs: call?.durationMs ?? step.durationMs,
        },
        approvalId: approval?.id,
      }
    })

    const decision = taskDecision(task)
    return {
      id: task.id,
      title: displayText(task.title.replace(/\.\.\.$/, '')),
      request: displayText(task.intent),
      requestedBy: task.actorEmail,
      requesterRole: findActor(task.requestedBy).role,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      decision,
      decisionLabel: actionDecisionLabel(decision),
      riskScore: task.riskScore,
      sourceCount: sources.size,
      actionCount: actionSteps.length,
      auditCount: events.length,
      summary: displayText(task.summary),
      approvalId: taskApproval?.id,
      approvalStatus: taskApproval?.status,
      steps: actionSteps,
    }
  })

export const buildSnapshot = (stateInput: GatewayState, filters?: SnapshotFilters): GatewaySnapshot => {
  const state = normalizeGatewayState(stateInput)
  const normalized = filters ?? {}
  const search = normalized.search?.toLowerCase()
  const connector = normalized.connector ?? 'all'
  const status = normalized.status ?? 'all'

  const filteredEvents = state.events.filter((event) => {
    if (connector !== 'all' && event.connector !== connector) return false
    if (status !== 'all' && event.status !== status) return false
    if (!search) return true
    return [
      event.summary,
      event.actorEmail,
      event.actorRole,
      event.connector,
      event.operation,
      event.target,
      event.policy,
      event.status,
      event.runId,
      event.taskId,
    ]
      .join(' ')
      .toLowerCase()
      .includes(search)
  })

  return {
    actionRuns: buildActionRuns(state),
    actors,
    connectors,
    events: filteredEvents,
    approvals: state.approvals,
    rules: state.rules,
    tasks: state.tasks,
    planSteps: state.planSteps,
    connectorCalls: state.connectorCalls,
    agentRuns: state.agentRuns.map(sanitizeAgentRun),
    ruleMessages: state.ruleMessages,
    stats: {
      totalEvents: state.events.length,
      totalRules: state.rules.length,
      totalTasks: state.tasks.length,
      totalAgentRuns: state.agentRuns.length,
      awaitingApproval: state.approvals.filter((approval) => approval.status === 'pending').length,
      blockedAgentRuns: state.agentRuns.filter((run) => run.status === 'blocked').length,
      connectorCount: connectors.length,
      lastDecision: state.tasks[0]?.decision ?? state.events[0]?.status ?? 'none',
    },
  }
}

export const exportAuditEvents = (state = getGatewayState()) =>
  state.events
    .slice()
    .reverse()
    .map((event) => JSON.stringify(event))
    .join('\n')
