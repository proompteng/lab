import type {
  ActionDecision,
  Connector,
  ConnectorCall,
  EventStatus,
  GatewayRule,
  PlanStepStatus,
  RuleMode,
  RuleTarget,
} from '~/server/gateway'

export type StatusLike =
  | EventStatus
  | PlanStepStatus
  | ActionDecision
  | 'waiting_approval'
  | 'approved'
  | 'denied'
  | 'pending'

export function formatTime(value: string) {
  return new Date(value).toISOString().slice(11, 19)
}

export function cleanTitle(value: string) {
  return userFacingText(value.replace(/\.\.\.$/, ''))
}

export function userFacingText(value: string) {
  return value
    .replaceAll('AgentRuns', 'protected workloads')
    .replaceAll('AgentRun', 'protected workload')
    .replaceAll('SQL policy state', 'policy data')
    .replaceAll('SQL', 'policy data')
    .replaceAll('REST', 'workload API')
    .replaceAll('GraphQL', 'audit graph')
    .replaceAll('legacy feed', 'operations feed')
    .replaceAll('legacy line-oriented status feed', 'operations status feed')
    .replaceAll('connector', 'source')
}

export function statusLabel(value: StatusLike) {
  const labels: Record<string, string> = {
    approval_required: 'Needs approval',
    needs_approval: 'Needs approval',
    waiting_approval: 'Waiting',
    received: 'Received',
    planned: 'Planned',
    accepted: 'Accepted',
    allowed: 'Allowed',
    denied: 'Denied',
    succeeded: 'Succeeded',
    failed: 'Failed',
    approved: 'Approved',
    blocked: 'Blocked',
    executed: 'Executed',
    pending: 'Pending',
  }
  return labels[value] ?? String(value).replaceAll('_', ' ')
}

export function statusBadgeVariant(value: StatusLike) {
  if (value === 'blocked' || value === 'denied' || value === 'failed') return 'destructive'
  if (value === 'approval_required' || value === 'needs_approval' || value === 'pending') return 'secondary'
  return 'outline'
}

export function sourceLabel(value: string) {
  const labels: Record<string, string> = {
    sql: 'Policy data',
    rest: 'Workload API',
    graphql: 'Audit graph',
    legacy: 'Ops feed',
    kubernetes: 'Workload control',
    policy: 'Policy gate',
    audit: 'Audit log',
  }
  return labels[value] ?? userFacingText(value)
}

export function operationLabel(value: string) {
  const labels: Record<string, string> = {
    'policy_context.read': 'Read current policy',
    'agentruns.list': 'Inspect protected workloads',
    'audit_graph.query': 'Reconcile audit history',
    'legacy_status.parse': 'Parse operations feed',
    'guarded_action.execute': 'Execute approved change',
    'task:intake': 'Receive request',
    'task:plan': 'Build action plan',
    'approval:request': 'Hold for approval',
    'approval:approve': 'Release approved action',
    'policy:block': 'Block unsafe action',
    'rule:create': 'Create policy',
    'agentrun:evaluate': 'Evaluate protected workload',
    'legacy.import': 'Import audit event',
  }
  return labels[value] ?? userFacingText(value)
}

export function targetLabel(value: string) {
  if (value.includes('sag.sql')) return 'Policy store'
  if (value.includes('kubernetes/apis/guarded-action')) return 'Workload controller'
  if (value.includes('kubernetes/apis') || value.includes('agents.proompteng.ai')) return 'Workload API'
  if (value.includes('sag.graphql')) return 'Audit graph'
  if (value.includes('line-protocol')) return 'Operations feed'
  if (value.includes('/api/events/export')) return 'Audit export'
  if (value.startsWith('postgresql://')) return 'Private policy store'
  if (value.startsWith('/api/internal/graphql')) return 'Server-side audit graph'
  return userFacingText(value)
}

export function policyLabel(value: string) {
  if (value === 'no-rule-match') return 'clear'
  if (value === 'identity-rbac-v1') return 'identity checked'
  if (value === 'connector-plan-v1') return 'plan recorded'
  if (value === 'approval-rbac-v1') return 'approval checked'
  if (value === 'natural-language-rule-builder-v2') return 'policy created'
  if (value.includes(',')) return `${value.split(',').filter(Boolean).length} policies matched`
  if (value.startsWith('rule-')) return 'policy matched'
  return userFacingText(value)
}

export function ruleModeLabel(value: RuleMode) {
  if (value === 'block') return 'Block'
  if (value === 'approval') return 'Approval'
  return 'Audit'
}

export function ruleTargetLabel(value: RuleTarget) {
  const labels: Record<RuleTarget, string> = {
    secret: 'Sensitive access',
    operation: 'Mutating work',
    connector: 'Source access',
    intent: 'Request language',
    identity: 'Identity',
  }
  return labels[value]
}

export function ruleScope(rule: GatewayRule) {
  if (rule.target === 'secret') return 'Sensitive secret names'
  if (rule.target === 'operation') return 'Write, restart, scale, grant, revoke'
  if (rule.target === 'connector') return 'Internal source access'
  if (rule.target === 'identity') return 'Actor permission'
  return 'Matching request language'
}

export function connectorAccessLabel(connector: Connector) {
  const labels: Record<string, string> = {
    sql: 'Private policy store',
    rest: 'In-cluster workload API',
    graphql: 'Server-side audit graph',
    legacy: 'Read-only operations feed',
    kubernetes: 'Workload admission surface',
    policy: 'Deterministic policy gate',
    audit: 'Append-only audit stream',
  }
  return labels[connector.id] ?? targetLabel(connector.target)
}

export function connectorGuardrailLabel(connector: Connector) {
  const labels: Record<string, string> = {
    sql: 'Scoped application role',
    rest: 'Read-only service account',
    graphql: 'Redacted server records',
    legacy: 'Parser redacts before planning',
    kubernetes: 'Evaluated before sensitive authority',
    policy: 'Runs before every action',
    audit: 'Inputs hashed, evidence redacted',
  }
  return labels[connector.id] ?? userFacingText(connector.trustBoundary)
}

export function approvalActionLabel(value: string) {
  if (value === 'guarded_action.execute') return 'Execute approved change'
  if (value === 'agentrun.execute') return 'Start protected workload'
  return operationLabel(value)
}

export function evidenceSummary(call: ConnectorCall) {
  const evidence = call.evidence
  const liveAgentRuns = typeof evidence.liveAgentRuns === 'number' ? evidence.liveAgentRuns : null
  const protectedWithSecrets = typeof evidence.protectedWithSecrets === 'number' ? evidence.protectedWithSecrets : null
  const linesParsed = typeof evidence.linesParsed === 'number' ? evidence.linesParsed : null
  const nodes = typeof evidence.nodes === 'number' ? evidence.nodes : null
  const tasks = typeof evidence.tasks === 'number' ? evidence.tasks : null
  const auditEvents = typeof evidence.auditEvents === 'number' ? evidence.auditEvents : null

  if (call.connector === 'rest' && liveAgentRuns !== null) {
    return `${liveAgentRuns} workloads inspected, ${protectedWithSecrets ?? 0} with sensitive authority.`
  }
  if (call.connector === 'legacy' && linesParsed !== null) return `${linesParsed} operations records normalized.`
  if (call.connector === 'graphql' && nodes !== null) return `${nodes} audit graph nodes reconciled.`
  if (call.connector === 'sql' && tasks !== null) {
    return `${tasks} requests and ${auditEvents ?? 0} audit events read from the policy store.`
  }
  return `${operationLabel(call.operation)} completed through ${sourceLabel(call.connector)}.`
}
