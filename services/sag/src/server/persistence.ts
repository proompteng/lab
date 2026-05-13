import postgres, { type Sql, type TransactionSql } from 'postgres'
import {
  actors,
  connectors,
  createGatewayState,
  getGatewayState,
  normalizeGatewayState,
  replaceGatewayState,
  resetGatewayState,
  type Approval,
  type ConnectorCall,
  type GatewayEvent,
  type GatewayRule,
  type GatewayState,
  type GatewayTask,
  type PlanStep,
  type ProtectedAgentRun,
  type RuleMessage,
  type WorkflowContext,
} from './gateway'

const stateKey = 'gateway'
let sql: Sql | null = null
let schemaReady = false
type DbClient = Sql | TransactionSql

const databaseUrl = () => process.env.DATABASE_URL?.trim()

const getSql = () => {
  const url = databaseUrl()
  if (!url) return null
  sql ??= postgres(url, { max: 2, idle_timeout: 20 })
  return sql
}

const ensureSchema = async (client: Sql) => {
  if (schemaReady) return

  await client`
    create table if not exists sag_state (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `
  await client`
    create table if not exists sag_identities (
      id text primary key,
      email text not null,
      name text not null,
      role text not null,
      permissions jsonb not null,
      updated_at timestamptz not null default now()
    )
  `
  await client`
    create table if not exists sag_connectors (
      id text primary key,
      name text not null,
      target text not null,
      operations jsonb not null,
      trust_boundary text not null,
      status text not null,
      updated_at timestamptz not null default now()
    )
  `
  await client`
    create table if not exists sag_policies (
      id text primary key,
      name text not null,
      mode text not null,
      target text not null,
      pattern text not null,
      enabled boolean not null,
      source text not null,
      created_by text not null,
      created_at timestamptz not null,
      summary text not null,
      translated_from text,
      translator text
    )
  `
  await client`
    create table if not exists sag_tasks (
      id text primary key,
      title text not null,
      intent text not null,
      requested_by text not null,
      actor_email text not null,
      status text not null,
      risk_score integer not null,
      decision text not null,
      summary text not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz,
      approval_id text,
      plan_step_ids jsonb not null,
      connector_call_ids jsonb not null
    )
  `
  await client`
    create table if not exists sag_plan_steps (
      id text primary key,
      task_id text not null,
      sequence integer not null,
      connector text not null,
      operation text not null,
      target text not null,
      status text not null,
      policy text not null,
      summary text not null,
      duration_ms integer not null,
      evidence jsonb not null
    )
  `
  await client`
    create table if not exists sag_connector_calls (
      id text primary key,
      task_id text not null,
      step_id text not null,
      connector text not null,
      operation text not null,
      target text not null,
      status text not null,
      started_at timestamptz not null,
      finished_at timestamptz not null,
      duration_ms integer not null,
      input_hash text not null,
      evidence jsonb not null
    )
  `
  await client`
    create table if not exists sag_approvals (
      id text primary key,
      run_id text not null,
      task_id text,
      action text not null,
      target text not null,
      status text not null,
      reason text not null,
      requested_by text not null,
      approved_by text,
      created_at timestamptz not null,
      decided_at timestamptz
    )
  `
  await client`
    create table if not exists sag_agent_runs (
      id text primary key,
      name text not null,
      namespace text not null,
      agent text not null,
      status text not null,
      requested_at timestamptz not null,
      risk_score integer not null,
      requested_secrets jsonb not null,
      requested_connectors jsonb not null,
      requested_tools jsonb not null,
      summary text not null,
      matched_rule_ids jsonb not null,
      manifest text not null
    )
  `
  await client`
    create table if not exists sag_rule_messages (
      id text primary key,
      role text not null,
      content text not null,
      created_at timestamptz not null,
      rule_id text
    )
  `
  await client`
    create table if not exists sag_audit_events (
      id text primary key,
      timestamp timestamptz not null,
      task_id text not null,
      run_id text not null,
      actor_id text not null,
      actor_email text not null,
      actor_role text not null,
      connector text not null,
      operation text not null,
      target text not null,
      status text not null,
      severity text not null,
      summary text not null,
      policy text not null,
      request_hash text not null,
      correlation_id text not null,
      duration_ms integer not null,
      evidence jsonb not null
    )
  `
  schemaReady = true
}

export const persistenceEnabled = () => Boolean(databaseUrl())

export const loadGatewayState = async () => {
  const client = getSql()
  if (!client) return getGatewayState()

  try {
    await ensureSchema(client)
    await seedStaticRows(client)
    const rules = await client<DbPolicy[]>`select * from sag_policies order by created_at desc`
    if (rules.length === 0) {
      const legacy = await client<{ value: Partial<GatewayState> }[]>`
        select value from sag_state where key = ${stateKey} limit 1
      `
      const state = normalizeGatewayState(legacy[0]?.value ?? createGatewayState())
      await saveGatewayState(state)
      return replaceGatewayState(state)
    }

    const state = normalizeGatewayState({
      sequence: await readSequence(client),
      rules: rules.map(policyRow),
      tasks: (await client<DbTask[]>`select * from sag_tasks order by created_at desc`).map(taskRow),
      planSteps: (await client<DbPlanStep[]>`select * from sag_plan_steps order by task_id, sequence`).map(planStepRow),
      connectorCalls: (await client<DbConnectorCall[]>`select * from sag_connector_calls order by started_at desc`).map(
        connectorCallRow,
      ),
      approvals: (await client<DbApproval[]>`select * from sag_approvals order by created_at desc`).map(approvalRow),
      agentRuns: (await client<DbAgentRun[]>`select * from sag_agent_runs order by requested_at desc`).map(agentRunRow),
      ruleMessages: (await client<DbRuleMessage[]>`select * from sag_rule_messages order by created_at desc`).map(
        ruleMessageRow,
      ),
      events: (await client<DbAuditEvent[]>`select * from sag_audit_events order by timestamp desc`).map(eventRow),
    })
    return replaceGatewayState(state)
  } catch (error) {
    console.error('sag.persistence.load_failed', error)
    return getGatewayState()
  }
}

export const saveGatewayState = async (stateInput: GatewayState) => {
  const client = getSql()
  if (!client) return

  const state = normalizeGatewayState(stateInput)
  try {
    await ensureSchema(client)
    await client.begin(async (tx) => {
      await seedStaticRows(tx)
      await tx`
        insert into sag_state (key, value, updated_at)
        values (${stateKey}, ${tx.json(state)}, now())
        on conflict (key) do update
        set value = excluded.value,
            updated_at = now()
      `

      for (const rule of state.rules) await upsertRule(tx, rule)
      for (const task of state.tasks) await upsertTask(tx, task)
      for (const step of state.planSteps) await upsertPlanStep(tx, step)
      for (const call of state.connectorCalls) await upsertConnectorCall(tx, call)
      for (const approval of state.approvals) await upsertApproval(tx, approval)
      for (const run of state.agentRuns) await upsertAgentRun(tx, run)
      for (const message of state.ruleMessages) await upsertRuleMessage(tx, message)
      for (const event of state.events) await upsertAuditEvent(tx, event)
    })
  } catch (error) {
    console.error('sag.persistence.save_failed', error)
  }
}

export const resetPersistentGatewayState = async () => {
  const state = resetGatewayState()
  const client = getSql()
  if (client) {
    await ensureSchema(client)
    await client.begin(async (tx) => {
      await tx`truncate sag_audit_events, sag_agent_runs, sag_approvals, sag_connector_calls, sag_plan_steps, sag_tasks, sag_rule_messages, sag_policies`
    })
  }
  await saveGatewayState(state)
  return state
}

export const readWorkflowContext = async (): Promise<WorkflowContext> => {
  const client = getSql()
  if (!client) {
    const state = getGatewayState()
    return {
      database: {
        source: 'memory',
        tasks: state.tasks.length,
        auditEvents: state.events.length,
        approvals: state.approvals.length,
        policies: state.rules.length,
        connectorCalls: state.connectorCalls.length,
      },
    }
  }

  await ensureSchema(client)
  const [tasks, auditEvents, approvals, policies, connectorCalls] = await Promise.all([
    countRows(client, 'sag_tasks'),
    countRows(client, 'sag_audit_events'),
    countRows(client, 'sag_approvals'),
    countRows(client, 'sag_policies'),
    countRows(client, 'sag_connector_calls'),
  ])
  return {
    database: {
      source: 'postgres',
      tasks,
      auditEvents,
      approvals,
      policies,
      connectorCalls,
    },
  }
}

const countRows = async (client: Sql, table: string) => {
  const rows = await client.unsafe<{ count: string }[]>(`select count(*)::text as count from ${table}`)
  return Number(rows[0]?.count ?? 0)
}

const seedStaticRows = async (client: DbClient) => {
  for (const actor of actors) {
    await client`
      insert into sag_identities (id, email, name, role, permissions, updated_at)
      values (${actor.id}, ${actor.email}, ${actor.name}, ${actor.role}, ${client.json(actor.permissions)}, now())
      on conflict (id) do update
      set email = excluded.email,
          name = excluded.name,
          role = excluded.role,
          permissions = excluded.permissions,
          updated_at = now()
    `
  }
  for (const connector of connectors) {
    await client`
      insert into sag_connectors (id, name, target, operations, trust_boundary, status, updated_at)
      values (
        ${connector.id},
        ${connector.name},
        ${connector.target},
        ${client.json(connector.operations)},
        ${connector.trustBoundary},
        ${connector.status},
        now()
      )
      on conflict (id) do update
      set name = excluded.name,
          target = excluded.target,
          operations = excluded.operations,
          trust_boundary = excluded.trust_boundary,
          status = excluded.status,
          updated_at = now()
    `
  }
}

const readSequence = async (client: Sql) => {
  const rows = await client<{ sequence: number }[]>`
    select greatest(
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_audit_events), 0),
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_tasks), 0),
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_plan_steps), 0),
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_connector_calls), 0),
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_approvals), 0),
      coalesce((select max(substring(id from '[0-9]+$')::integer) from sag_agent_runs), 0)
    ) as sequence
  `
  return Number(rows[0]?.sequence ?? 0)
}

const upsertRule = (client: DbClient, rule: GatewayRule) => client`
  insert into sag_policies (
    id, name, mode, target, pattern, enabled, source, created_by, created_at, summary, translated_from, translator
  )
  values (
    ${rule.id},
    ${rule.name},
    ${rule.mode},
    ${rule.target},
    ${rule.pattern},
    ${rule.enabled},
    ${rule.source},
    ${rule.createdBy},
    ${rule.createdAt},
    ${rule.summary},
    ${rule.translatedFrom ?? null},
    ${rule.translator ?? null}
  )
  on conflict (id) do update
  set name = excluded.name,
      mode = excluded.mode,
      target = excluded.target,
      pattern = excluded.pattern,
      enabled = excluded.enabled,
      source = excluded.source,
      summary = excluded.summary,
      translated_from = excluded.translated_from,
      translator = excluded.translator
`

const upsertTask = (client: DbClient, task: GatewayTask) => client`
  insert into sag_tasks (
    id, title, intent, requested_by, actor_email, status, risk_score, decision, summary, created_at, updated_at,
    completed_at, approval_id, plan_step_ids, connector_call_ids
  )
  values (
    ${task.id},
    ${task.title},
    ${task.intent},
    ${task.requestedBy},
    ${task.actorEmail},
    ${task.status},
    ${task.riskScore},
    ${task.decision},
    ${task.summary},
    ${task.createdAt},
    ${task.updatedAt},
    ${task.completedAt ?? null},
    ${task.approvalId ?? null},
    ${client.json(task.planStepIds)},
    ${client.json(task.connectorCallIds)}
  )
  on conflict (id) do update
  set title = excluded.title,
      intent = excluded.intent,
      status = excluded.status,
      risk_score = excluded.risk_score,
      decision = excluded.decision,
      summary = excluded.summary,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      approval_id = excluded.approval_id,
      plan_step_ids = excluded.plan_step_ids,
      connector_call_ids = excluded.connector_call_ids
`

const upsertPlanStep = (client: DbClient, step: PlanStep) => client`
  insert into sag_plan_steps (
    id, task_id, sequence, connector, operation, target, status, policy, summary, duration_ms, evidence
  )
  values (
    ${step.id},
    ${step.taskId},
    ${step.sequence},
    ${step.connector},
    ${step.operation},
    ${step.target},
    ${step.status},
    ${step.policy},
    ${step.summary},
    ${step.durationMs},
    ${client.json(step.evidence)}
  )
  on conflict (id) do update
  set status = excluded.status,
      policy = excluded.policy,
      summary = excluded.summary,
      duration_ms = excluded.duration_ms,
      evidence = excluded.evidence
`

const upsertConnectorCall = (client: DbClient, call: ConnectorCall) => client`
  insert into sag_connector_calls (
    id, task_id, step_id, connector, operation, target, status, started_at, finished_at, duration_ms, input_hash, evidence
  )
  values (
    ${call.id},
    ${call.taskId},
    ${call.stepId},
    ${call.connector},
    ${call.operation},
    ${call.target},
    ${call.status},
    ${call.startedAt},
    ${call.finishedAt},
    ${call.durationMs},
    ${call.inputHash},
    ${client.json(call.evidence)}
  )
  on conflict (id) do update
  set status = excluded.status,
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      evidence = excluded.evidence
`

const upsertApproval = (client: DbClient, approval: Approval) => client`
  insert into sag_approvals (
    id, run_id, task_id, action, target, status, reason, requested_by, approved_by, created_at, decided_at
  )
  values (
    ${approval.id},
    ${approval.runId},
    ${approval.taskId ?? null},
    ${approval.action},
    ${approval.target},
    ${approval.status},
    ${approval.reason},
    ${approval.requestedBy},
    ${approval.approvedBy ?? null},
    ${approval.createdAt},
    ${approval.decidedAt ?? null}
  )
  on conflict (id) do update
  set status = excluded.status,
      approved_by = excluded.approved_by,
      decided_at = excluded.decided_at
`

const upsertAgentRun = (client: DbClient, run: ProtectedAgentRun) => client`
  insert into sag_agent_runs (
    id, name, namespace, agent, status, requested_at, risk_score, requested_secrets, requested_connectors,
    requested_tools, summary, matched_rule_ids, manifest
  )
  values (
    ${run.id},
    ${run.name},
    ${run.namespace},
    ${run.agent},
    ${run.status},
    ${run.requestedAt},
    ${run.riskScore},
    ${client.json(run.requestedSecrets)},
    ${client.json(run.requestedConnectors)},
    ${client.json(run.requestedTools)},
    ${run.summary},
    ${client.json(run.matchedRuleIds)},
    ${run.manifest}
  )
  on conflict (id) do update
  set status = excluded.status,
      summary = excluded.summary,
      manifest = excluded.manifest
`

const upsertRuleMessage = (client: DbClient, message: RuleMessage) => client`
  insert into sag_rule_messages (id, role, content, created_at, rule_id)
  values (${message.id}, ${message.role}, ${message.content}, ${message.createdAt}, ${message.ruleId ?? null})
  on conflict (id) do update
  set content = excluded.content,
      rule_id = excluded.rule_id
`

const upsertAuditEvent = (client: DbClient, event: GatewayEvent) => client`
  insert into sag_audit_events (
    id, timestamp, task_id, run_id, actor_id, actor_email, actor_role, connector, operation, target, status,
    severity, summary, policy, request_hash, correlation_id, duration_ms, evidence
  )
  values (
    ${event.id},
    ${event.timestamp},
    ${event.taskId},
    ${event.runId},
    ${event.actorId},
    ${event.actorEmail},
    ${event.actorRole},
    ${event.connector},
    ${event.operation},
    ${event.target},
    ${event.status},
    ${event.severity},
    ${event.summary},
    ${event.policy},
    ${event.requestHash},
    ${event.correlationId},
    ${event.durationMs},
    ${client.json(event.evidence)}
  )
  on conflict (id) do nothing
`

type DbPolicy = Omit<GatewayRule, 'createdBy' | 'createdAt' | 'translatedFrom'> & {
  created_by: GatewayRule['createdBy']
  created_at: Date | string
  translated_from: string | null
}

type DbTask = Omit<
  GatewayTask,
  | 'requestedBy'
  | 'actorEmail'
  | 'riskScore'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'approvalId'
  | 'planStepIds'
  | 'connectorCallIds'
> & {
  requested_by: GatewayTask['requestedBy']
  actor_email: string
  risk_score: number
  created_at: Date | string
  updated_at: Date | string
  completed_at: Date | string | null
  approval_id: string | null
  plan_step_ids: string[]
  connector_call_ids: string[]
}

type DbPlanStep = Omit<PlanStep, 'taskId' | 'durationMs'> & {
  task_id: string
  duration_ms: number
}

type DbConnectorCall = Omit<
  ConnectorCall,
  'taskId' | 'stepId' | 'startedAt' | 'finishedAt' | 'durationMs' | 'inputHash'
> & {
  task_id: string
  step_id: string
  started_at: Date | string
  finished_at: Date | string
  duration_ms: number
  input_hash: string
}

type DbApproval = Omit<Approval, 'runId' | 'taskId' | 'requestedBy' | 'approvedBy' | 'createdAt' | 'decidedAt'> & {
  run_id: string
  task_id: string | null
  requested_by: Approval['requestedBy']
  approved_by: Approval['approvedBy'] | null
  created_at: Date | string
  decided_at: Date | string | null
}

type DbAgentRun = Omit<
  ProtectedAgentRun,
  'requestedAt' | 'riskScore' | 'requestedSecrets' | 'requestedConnectors' | 'requestedTools' | 'matchedRuleIds'
> & {
  requested_at: Date | string
  risk_score: number
  requested_secrets: ProtectedAgentRun['requestedSecrets']
  requested_connectors: ProtectedAgentRun['requestedConnectors']
  requested_tools: ProtectedAgentRun['requestedTools']
  matched_rule_ids: ProtectedAgentRun['matchedRuleIds']
}

type DbRuleMessage = Omit<RuleMessage, 'createdAt' | 'ruleId'> & {
  created_at: Date | string
  rule_id: string | null
}

type DbAuditEvent = Omit<
  GatewayEvent,
  | 'timestamp'
  | 'taskId'
  | 'runId'
  | 'actorId'
  | 'actorEmail'
  | 'actorRole'
  | 'requestHash'
  | 'correlationId'
  | 'durationMs'
> & {
  timestamp: Date | string
  task_id: string
  run_id: string
  actor_id: GatewayEvent['actorId']
  actor_email: string
  actor_role: string
  request_hash: string
  correlation_id: string
  duration_ms: number
}

const iso = (value: Date | string | null | undefined) => {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

const policyRow = (row: DbPolicy): GatewayRule => ({
  id: row.id,
  name: row.name,
  mode: row.mode,
  target: row.target,
  pattern: row.pattern,
  enabled: Boolean(row.enabled),
  source: row.source,
  createdBy: row.created_by,
  createdAt: iso(row.created_at) ?? new Date().toISOString(),
  summary: row.summary,
  translatedFrom: row.translated_from ?? undefined,
  translator: row.translator,
})

const taskRow = (row: DbTask): GatewayTask => ({
  id: row.id,
  title: row.title,
  intent: row.intent,
  requestedBy: row.requested_by,
  actorEmail: row.actor_email,
  status: row.status,
  riskScore: row.risk_score,
  decision: row.decision,
  summary: row.summary,
  createdAt: iso(row.created_at) ?? new Date().toISOString(),
  updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  completedAt: iso(row.completed_at),
  approvalId: row.approval_id ?? undefined,
  planStepIds: row.plan_step_ids ?? [],
  connectorCallIds: row.connector_call_ids ?? [],
})

const planStepRow = (row: DbPlanStep): PlanStep => ({
  id: row.id,
  taskId: row.task_id,
  sequence: row.sequence,
  connector: row.connector,
  operation: row.operation,
  target: row.target,
  status: row.status,
  policy: row.policy,
  summary: row.summary,
  durationMs: row.duration_ms,
  evidence: row.evidence,
})

const connectorCallRow = (row: DbConnectorCall): ConnectorCall => ({
  id: row.id,
  taskId: row.task_id,
  stepId: row.step_id,
  connector: row.connector,
  operation: row.operation,
  target: row.target,
  status: row.status,
  startedAt: iso(row.started_at) ?? new Date().toISOString(),
  finishedAt: iso(row.finished_at) ?? new Date().toISOString(),
  durationMs: row.duration_ms,
  inputHash: row.input_hash,
  evidence: row.evidence,
})

const approvalRow = (row: DbApproval): Approval => ({
  id: row.id,
  runId: row.run_id,
  taskId: row.task_id ?? undefined,
  action: row.action,
  target: row.target,
  status: row.status,
  reason: row.reason,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by ?? undefined,
  createdAt: iso(row.created_at) ?? new Date().toISOString(),
  decidedAt: iso(row.decided_at),
})

const agentRunRow = (row: DbAgentRun): ProtectedAgentRun => ({
  id: row.id,
  name: row.name,
  namespace: row.namespace,
  agent: row.agent,
  status: row.status,
  requestedAt: iso(row.requested_at) ?? new Date().toISOString(),
  riskScore: row.risk_score,
  requestedSecrets: row.requested_secrets ?? [],
  requestedConnectors: row.requested_connectors ?? [],
  requestedTools: row.requested_tools ?? [],
  summary: row.summary,
  matchedRuleIds: row.matched_rule_ids ?? [],
  manifest: row.manifest,
})

const ruleMessageRow = (row: DbRuleMessage): RuleMessage => ({
  id: row.id,
  role: row.role,
  content: row.content,
  createdAt: iso(row.created_at) ?? new Date().toISOString(),
  ruleId: row.rule_id ?? undefined,
})

const eventRow = (row: DbAuditEvent): GatewayEvent => ({
  id: row.id,
  timestamp: iso(row.timestamp) ?? new Date().toISOString(),
  taskId: row.task_id,
  runId: row.run_id,
  actorId: row.actor_id,
  actorEmail: row.actor_email,
  actorRole: row.actor_role,
  connector: row.connector,
  operation: row.operation,
  target: row.target,
  status: row.status,
  severity: row.severity,
  summary: row.summary,
  policy: row.policy,
  requestHash: row.request_hash,
  correlationId: row.correlation_id,
  durationMs: row.duration_ms,
  evidence: row.evidence,
})
