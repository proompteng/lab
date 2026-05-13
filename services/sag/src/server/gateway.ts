import { z } from 'zod'

export type ActorId = 'greg' | 'ops' | 'audit'
export type ConnectorKind = 'kubernetes' | 'postgres' | 'policy' | 'audit'
export type EventStatus = 'accepted' | 'allowed' | 'denied' | 'succeeded' | 'approval_required' | 'approved' | 'blocked'
export type Severity = 'info' | 'notice' | 'warning' | 'critical'

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
}

export type GatewayEvent = {
  id: string
  timestamp: string
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
  evidence: Record<string, string | number | boolean | string[]>
}

export type Approval = {
  id: string
  runId: string
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
  mode: 'block' | 'approval' | 'audit'
  target: 'agentrun.secret' | 'agentrun.connector' | 'connector.action' | 'prompt'
  pattern: string
  enabled: boolean
  source: 'system' | 'natural-language'
  createdBy: ActorId
  createdAt: string
  summary: string
  translatedFrom?: string
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
  actors: Actor[]
  connectors: Connector[]
  events: GatewayEvent[]
  approvals: Approval[]
  rules: GatewayRule[]
  agentRuns: ProtectedAgentRun[]
  ruleMessages: RuleMessage[]
  stats: {
    totalEvents: number
    totalRules: number
    totalAgentRuns: number
    awaitingApproval: number
    blockedAgentRuns: number
    connectorCount: number
  }
}

export type GatewayState = {
  sequence: number
  events: GatewayEvent[]
  approvals: Approval[]
  rules: GatewayRule[]
  agentRuns: ProtectedAgentRun[]
  ruleMessages: RuleMessage[]
}

const actors: Actor[] = [
  {
    id: 'greg',
    name: 'Greg Konush',
    email: 'greg@proompteng.ai',
    role: 'Security Operator',
    permissions: ['audit:read', 'rule:create', 'agentrun:evaluate', 'approval:approve'],
  },
  {
    id: 'ops',
    name: 'Operations Approver',
    email: 'ops@proompteng.ai',
    role: 'Operations Approver',
    permissions: ['audit:read', 'agentrun:evaluate'],
  },
  {
    id: 'audit',
    name: 'Audit Reader',
    email: 'audit@proompteng.ai',
    role: 'Audit Reader',
    permissions: ['audit:read'],
  },
]

const connectors: Connector[] = [
  {
    id: 'kubernetes',
    name: 'Kubernetes AgentRuns',
    target: 'agents.proompteng.ai/v1alpha1',
    operations: ['list AgentRuns', 'inspect requested secrets', 'inspect runtime policy'],
    trustBoundary: 'read-only service account scoped to AgentRun and Job metadata',
  },
  {
    id: 'postgres',
    name: 'SAG State Store',
    target: 'postgresql://sag-db-rw.sag/sag',
    operations: ['persist rules', 'persist decisions', 'persist audit state'],
    trustBoundary: 'CNPG application user scoped to the sag database',
  },
  {
    id: 'policy',
    name: 'Policy Engine',
    target: 'sag.policy/rules',
    operations: ['translate rule', 'evaluate AgentRun', 'require approval', 'block unsafe access'],
    trustBoundary: 'deterministic rules run before an AgentRun receives sensitive runtime authority',
  },
  {
    id: 'audit',
    name: 'Audit Stream',
    target: '/api/events/export',
    operations: ['append event', 'export JSONL', 'redact sensitive evidence'],
    trustBoundary: 'hashes raw requests and stores only redacted evidence',
  },
]

const defaultRules = (): GatewayRule[] => [
  {
    id: 'rule-secret-boundary',
    name: 'Block sensitive secret requests',
    mode: 'block',
    target: 'agentrun.secret',
    pattern: '(prod|production|payment|superuser|root|password|token|auth)',
    enabled: true,
    source: 'system',
    createdBy: 'greg',
    createdAt: now(),
    summary: 'AgentRuns cannot receive sensitive secret references without an explicit policy exception.',
  },
  {
    id: 'rule-mutation-approval',
    name: 'Approve mutating runtime actions',
    mode: 'approval',
    target: 'connector.action',
    pattern: '(write|writeback|update|delete|execute|mutate|apply|merge)',
    enabled: true,
    source: 'system',
    createdBy: 'greg',
    createdAt: now(),
    summary: 'AgentRun actions that mutate systems require approval before execution.',
  },
]

const globalForSag = globalThis as typeof globalThis & {
  __secureActionGatewayState?: GatewayState
}

const actorSchema = z.enum(['greg', 'ops', 'audit'])

const snapshotInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    connector: z.enum(['all', 'kubernetes', 'postgres', 'policy', 'audit']).default('all'),
    status: z
      .enum(['all', 'accepted', 'allowed', 'denied', 'succeeded', 'approval_required', 'approved', 'blocked'])
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

const agentRunEvaluationSchema = z
  .object({
    actorId: actorSchema,
    name: z.string().trim().min(2).max(120).optional(),
    namespace: z.string().trim().min(1).max(80).optional(),
    agent: z.string().trim().min(1).max(120).optional(),
    requestedSecrets: z.array(z.string().trim().min(1).max(160)).max(24).optional(),
    requestedConnectors: z
      .array(z.enum(['kubernetes', 'postgres', 'policy', 'audit']))
      .max(8)
      .optional(),
    requestedTools: z.array(z.string().trim().min(1).max(160)).max(24).optional(),
    manifest: z.string().trim().max(8000).optional(),
  })
  .optional()

export type SnapshotFilters = z.infer<typeof snapshotInputSchema>
export type ApprovalInput = z.infer<typeof approvalSchema>
export type RuleBuilderInput = z.infer<typeof ruleBuilderSchema>
export type AgentRunEvaluationInput = z.infer<typeof agentRunEvaluationSchema>

const now = () => new Date().toISOString()

const hashPayload = (value: unknown) => {
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const redactName = (prefix: string, value: string) => `${prefix}:${hashPayload(value).slice(0, 10)}`

const redactManifest = (manifest: string, secrets: string[]) =>
  secrets.reduce((value, secret) => value.split(secret).join(redactName('secret', secret)), manifest)

const redactManifestSecretList = (manifest: string) => {
  try {
    const parsed = JSON.parse(manifest) as { spec?: { secrets?: unknown[] } }
    if (Array.isArray(parsed.spec?.secrets)) {
      parsed.spec.secrets = parsed.spec.secrets.map((secret) => {
        if (typeof secret === 'string') return secret.startsWith('secret:') ? secret : redactName('secret', secret)
        if (secret && typeof secret === 'object' && 'name' in secret && typeof secret.name === 'string') {
          return {
            ...secret,
            name: secret.name.startsWith('secret:') ? secret.name : redactName('secret', secret.name),
          }
        }
        return '<redacted>'
      })
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return manifest
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
  return `${prefix}-${String(state.sequence).padStart(4, '0')}`
}

export const createGatewayState = (): GatewayState => ({
  sequence: 0,
  events: [],
  approvals: [],
  rules: defaultRules(),
  agentRuns: [],
  ruleMessages: [],
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
  globalForSag.__secureActionGatewayState = state
  return state
}

export const createEmptyGatewaySnapshot = () => buildSnapshot(createGatewayState())

const findActor = (actorId: ActorId) => {
  const actor = actors.find((item) => item.id === actorId)
  if (!actor) throw new Error(`Unknown actor: ${actorId}`)
  return actor
}

const hasPermission = (actor: Actor, permission: string) => actor.permissions.includes(permission)

const appendEvent = (
  state: GatewayState,
  input: Omit<GatewayEvent, 'id' | 'timestamp' | 'requestHash' | 'correlationId'> & { request?: unknown },
) => {
  const { request, ...eventInput } = input
  const event: GatewayEvent = {
    ...eventInput,
    id: nextId(state, 'evt'),
    timestamp: now(),
    requestHash: hashPayload(request ?? input.evidence),
    correlationId: `${input.runId}:${state.sequence + 1}`,
  }
  state.events.unshift(event)
  return event
}

export const approveAction = (state: GatewayState, input: ApprovalInput) => {
  const actor = findActor(input.actorId)
  const approval = state.approvals.find((item) => item.id === input.approvalId)
  if (!approval) throw new Error(`Approval not found: ${input.approvalId}`)

  if (!hasPermission(actor, 'approval:approve')) {
    appendEvent(state, {
      runId: approval.runId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      connector: 'policy',
      operation: 'approval:approve',
      target: approval.target,
      status: 'denied',
      severity: 'critical',
      summary: `${actor.role} cannot approve this action`,
      policy: 'approval-rbac-v1',
      durationMs: 4,
      evidence: { approvalId: approval.id, decision: 'deny', permission: 'approval:approve' },
      request: input,
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

  appendEvent(state, {
    runId: approval.runId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    connector: 'policy',
    operation: 'approval:approve',
    target: approval.target,
    status: 'approved',
    severity: 'notice',
    summary: `Approved ${approval.action}`,
    policy: 'approval-rbac-v1',
    durationMs: 7,
    evidence: { approvalId: approval.id, decision: 'approve' },
    request: input,
  })
  return { ok: true as const, agentRun }
}

const safeRuleRegex = (rule: GatewayRule) => {
  try {
    return new RegExp(rule.pattern, 'i')
  } catch {
    return /$a/
  }
}

const summarizeRule = (rule: GatewayRule) => {
  if (rule.mode === 'block' && rule.target === 'agentrun.secret') {
    return `Block AgentRuns requesting secrets matching ${rule.pattern}`
  }
  if (rule.mode === 'approval') {
    return `Require approval when ${rule.target} matches ${rule.pattern}`
  }
  return `Audit ${rule.target} when it matches ${rule.pattern}`
}

const parseRuleIntent = (text: string): Omit<GatewayRule, 'id' | 'createdAt' | 'createdBy' | 'summary'> => {
  const mentionsSecret = /\b(secret|token|password|credential|key|auth)\b/i.test(text)
  const asksApproval = /\b(approval|approve|review|human|hold)\b/i.test(text)
  const asksBlock = /\b(block|deny|stop|prevent|disallow)\b/i.test(text)

  if (mentionsSecret) {
    return {
      name: asksBlock ? 'Block sensitive AgentRun secrets' : 'Audit AgentRun secret requests',
      mode: asksBlock ? 'block' : 'audit',
      target: 'agentrun.secret',
      pattern: '(prod|production|payment|superuser|root|password|token|auth)',
      enabled: true,
      source: 'natural-language',
      translatedFrom: text,
    }
  }

  if (asksApproval) {
    return {
      name: 'Require approval for mutating AgentRun actions',
      mode: 'approval',
      target: 'connector.action',
      pattern: '(write|writeback|update|delete|execute|mutate|apply|merge)',
      enabled: true,
      source: 'natural-language',
      translatedFrom: text,
    }
  }

  return {
    name: 'Audit matching AgentRuns',
    mode: 'audit',
    target: 'prompt',
    pattern: text
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join('|'),
    enabled: true,
    source: 'natural-language',
    translatedFrom: text,
  }
}

export const createRuleFromText = (state: GatewayState, input: RuleBuilderInput) => {
  const actor = findActor(input.actorId)
  const parsed = parseRuleIntent(input.text)
  const rule: GatewayRule = {
    ...parsed,
    id: nextId(state, 'rule'),
    createdBy: actor.id,
    createdAt: now(),
    summary: summarizeRule({
      ...parsed,
      id: 'preview',
      createdBy: actor.id,
      createdAt: now(),
      summary: '',
    }),
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
      content: input.text,
      createdAt: now(),
    },
  )

  appendEvent(state, {
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
    policy: 'natural-language-rule-builder-v1',
    durationMs: 12,
    evidence: {
      ruleId: rule.id,
      mode: rule.mode,
      pattern: rule.pattern,
      source: rule.source,
    },
    request: input,
  })
  return rule
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

const agentRunManifest = (
  request: ReturnType<typeof defaultAgentRunRequest>,
) => `apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: ${request.name}
  namespace: ${request.namespace}
spec:
  agentRef:
    name: ${request.agent}
  secrets:
${request.requestedSecrets.map((secret) => `    - name: ${redactName('secret', secret)}`).join('\n')}
`

export const evaluateAgentRun = (state: GatewayState, input?: AgentRunEvaluationInput) => {
  const request = defaultAgentRunRequest(input)
  const actor = findActor(request.actorId)
  const activeRules = state.rules.filter((rule) => rule.enabled)
  const matchedRules = activeRules.filter((rule) => {
    const regex = safeRuleRegex(rule)
    if (rule.target === 'agentrun.secret') {
      return request.requestedSecrets.some((secret) => regex.test(secret))
    }
    if (rule.target === 'agentrun.connector' || rule.target === 'connector.action') {
      return [...request.requestedConnectors, ...request.requestedTools].some((value) => regex.test(value))
    }
    return regex.test(request.manifest ?? agentRunManifest(request))
  })
  const blockingRules = matchedRules.filter((rule) => rule.mode === 'block')
  const approvalRules = matchedRules.filter((rule) => rule.mode === 'approval')
  const status: ProtectedAgentRun['status'] =
    blockingRules.length > 0 ? 'blocked' : approvalRules.length > 0 ? 'approval_required' : 'allowed'
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
    summary:
      status === 'blocked'
        ? `Blocked ${request.name} before sensitive runtime authority was attached`
        : status === 'approval_required'
          ? `Held ${request.name} for approval`
          : `Allowed ${request.name} with audit capture`,
    matchedRuleIds: matchedRules.map((rule) => rule.id),
    manifest: request.manifest ? redactManifest(request.manifest, request.requestedSecrets) : agentRunManifest(request),
  }
  state.agentRuns.unshift(protectedRun)

  if (status === 'approval_required') {
    state.approvals.unshift({
      id: nextId(state, 'appr'),
      runId: protectedRun.id,
      action: 'agentrun.execute',
      target: `${protectedRun.namespace}/${protectedRun.name}`,
      status: 'pending',
      reason: 'Matched approval rule before guarded execution',
      requestedBy: actor.id,
      createdAt: now(),
    })
  }

  appendEvent(state, {
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

export const buildSnapshot = (state: GatewayState, filters?: SnapshotFilters): GatewaySnapshot => {
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
    ]
      .join(' ')
      .toLowerCase()
      .includes(search)
  })

  return {
    actors,
    connectors,
    events: filteredEvents,
    approvals: state.approvals,
    rules: state.rules,
    agentRuns: state.agentRuns.map(sanitizeAgentRun),
    ruleMessages: state.ruleMessages,
    stats: {
      totalEvents: state.events.length,
      totalRules: state.rules.length,
      totalAgentRuns: state.agentRuns.length,
      awaitingApproval: state.approvals.filter((approval) => approval.status === 'pending').length,
      blockedAgentRuns: state.agentRuns.filter((run) => run.status === 'blocked').length,
      connectorCount: connectors.length,
    },
  }
}

export const exportAuditEvents = (state = getGatewayState()) =>
  state.events
    .slice()
    .reverse()
    .map((event) => JSON.stringify(event))
    .join('\n')
