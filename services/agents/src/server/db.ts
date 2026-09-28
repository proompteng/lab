import { type Generated, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { resolveEffectiveSslMode, resolveSslConfig } from './postgres-ssl'
import { resolveAgentsDatabaseConfig } from './storage-config'

export type Db = Kysely<AgentsDatabase>
export type StoreDbResolution = {
  db: Db | null
  shared: boolean
  url: string | null
}

type Timestamp = string | Date
type JsonValue = Record<string, unknown>

type AgentRuns = {
  id: Generated<string>
  agent_name: string
  delivery_id: string
  provider: string
  status: string
  external_run_id: string | null
  payload: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AgentRunIdempotencyKeys = {
  id: Generated<string>
  namespace: string
  agent_name: string
  idempotency_key: string
  agent_run_name: string | null
  agent_run_uid: string | null
  terminal_phase: string | null
  terminal_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AgentRunRerunSubmissions = {
  id: Generated<string>
  parent_ref: string
  parent_agent_run_id: string | null
  parent_agent_run_name: string | null
  parent_agent_run_namespace: string | null
  attempt: number
  delivery_id: string
  status: string
  submission_attempt: number
  response_status: number | null
  error: string | null
  request_payload: JsonValue
  response_payload: JsonValue | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  submitted_at: Timestamp | null
}

export type LinearMcpMutationReceipts = {
  id: Generated<string>
  agent_run_uid: string
  agent_run_name: string
  agent_run_namespace: string
  issue_uuid: string
  issue_identifier: string
  tool: string
  canonical_argument_hash: string
  state: string
  attempt_count: Generated<number>
  sanitized_result_id: string | null
  last_error_code: string | null
  requested_at: Generated<Timestamp>
  started_at: Timestamp | null
  completed_at: Timestamp | null
  updated_at: Generated<Timestamp>
}

type MemoryResources = {
  id: Generated<string>
  memory_name: string
  provider: string
  status: string
  connection_secret: JsonValue | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type MemoryEntries = {
  id: Generated<string>
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  execution_id: string | null
  task_name: string
  task_description: string | null
  repository_ref: Generated<string>
  repository_commit: string | null
  repository_path: string | null
  content: string
  summary: string
  metadata: JsonValue
  tags: string[]
  source: string
  embedding: unknown
  encoder_model: string
  encoder_version: string | null
  last_accessed_at: Timestamp | null
  next_review_at: Timestamp | null
}

type OrchestrationRuns = {
  id: Generated<string>
  orchestration_name: string
  delivery_id: string
  provider: string
  status: string
  external_run_id: string | null
  payload: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AuditEvents = {
  id: Generated<string>
  entity_type: string
  entity_id: string
  event_type: string
  payload: JsonValue
  created_at: Generated<Timestamp>
}

type AgentsControlPlaneResourcesCurrent = {
  id: Generated<string>
  cluster: Generated<string>
  kind: string
  namespace: string
  name: string
  uid: string | null
  api_version: string | null
  resource_version: string | null
  generation: number | null
  labels: JsonValue
  annotations: JsonValue
  resource: JsonValue
  fingerprint: string
  resource_created_at: Timestamp | null
  resource_updated_at: Timestamp | null
  status_phase: string | null
  spec_runtime_type: string | null
  spec_agent_ref_name: string | null
  spec_implementation_spec_ref_name: string | null
  spec_source_provider: string | null
  spec_source_external_id: string | null
  spec_summary: string | null
  spec_labels: string[]
  last_seen_at: Generated<Timestamp>
  deleted_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AgentsCommsAgentMessage = {
  id: Generated<string>
  agent_run_uid: string | null
  agent_run_name: string | null
  agent_run_namespace: string | null
  run_id: string | null
  step_id: string | null
  agent_id: string | null
  role: string
  kind: string
  timestamp: Timestamp
  channel: string | null
  stage: string | null
  content: string
  attrs: JsonValue
  dedupe_key: string | null
  created_at: Generated<Timestamp>
}

type AgentsCodexRun = {
  id: Generated<string>
  repository: string
  issue_number: number
  branch: string
  attempt: number
  agent_run_name: string
  agent_run_uid: string | null
  agent_run_namespace: string | null
  turn_id: string | null
  thread_id: string | null
  stage: string | null
  status: string
  phase: string | null
  iteration: number | null
  iteration_cycle: number | null
  prompt: string | null
  next_prompt: string | null
  commit_sha: string | null
  pr_number: number | null
  pr_url: string | null
  pr_state: string | null
  pr_merged: boolean | null
  ci_status: string | null
  ci_url: string | null
  ci_status_updated_at: Timestamp | null
  review_status: string | null
  review_summary: JsonValue
  review_status_updated_at: Timestamp | null
  notify_payload: JsonValue | null
  run_complete_payload: JsonValue | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  started_at: Timestamp | null
  finished_at: Timestamp | null
}

type AgentsCodexArtifact = {
  id: Generated<string>
  run_id: string
  name: string
  key: string
  bucket: string | null
  url: string | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AgentsCodexEvaluation = {
  id: Generated<string>
  run_id: string
  decision: string
  confidence: number | null
  reasons: JsonValue
  missing_items: JsonValue
  suggested_fixes: JsonValue
  next_prompt: string | null
  system_suggestions: JsonValue
  created_at: Generated<Timestamp>
}

export type AgentsDatabase = {
  agent_runs: AgentRuns
  agent_run_idempotency_keys: AgentRunIdempotencyKeys
  agent_run_rerun_submissions: AgentRunRerunSubmissions
  linear_mcp_mutation_receipts: LinearMcpMutationReceipts
  memory_resources: MemoryResources
  'memories.entries': MemoryEntries
  orchestration_runs: OrchestrationRuns
  audit_events: AuditEvents
  'agents_control_plane.resources_current': AgentsControlPlaneResourcesCurrent
  'agents_comms.agent_messages': AgentsCommsAgentMessage
  'agents_codex.runs': AgentsCodexRun
  'agents_codex.artifacts': AgentsCodexArtifact
  'agents_codex.evaluations': AgentsCodexEvaluation
}

let db: Db | null | undefined

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_QUERY_TIMEOUT_MS = 20_000

const normalizeDbUrl = (value: string | undefined | null) => value?.trim() ?? ''

const createDbClient = (rawUrl: string): Db => {
  const url = rawUrl.trim()
  const sslmode = resolveEffectiveSslMode(url)
  const databaseConfig = resolveAgentsDatabaseConfig()
  const ssl = resolveSslConfig(sslmode, databaseConfig.caCertPath ?? undefined)

  const pool = new Pool({
    connectionString: url,
    ssl,
    keepAlive: true,
    max: databaseConfig.poolMax,
    connectionTimeoutMillis: databaseConfig.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    query_timeout: databaseConfig.queryTimeoutMs || DEFAULT_QUERY_TIMEOUT_MS,
  })

  pool.on('error', (error) => {
    console.warn('[agents] postgres pool error', error)
  })

  return new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({ pool }),
  })
}

const shouldReuseSharedDb = (options: { url?: string; createDb?: (url: string) => Db }) => {
  if (options.createDb) return false
  const envUrl = normalizeDbUrl(resolveAgentsDatabaseConfig().url)
  const resolvedUrl = normalizeDbUrl(options.url) || envUrl
  return resolvedUrl.length > 0 && resolvedUrl === envUrl
}

export const getDb = () => {
  if (db !== undefined) return db

  const url = normalizeDbUrl(resolveAgentsDatabaseConfig().url)
  if (!url) {
    db = null
    return db
  }

  db = createDbClient(url)
  return db
}

export const createKyselyDb = (url: string) => createDbClient(url)

export const resolveStoreDb = (options: { url?: string; createDb?: (url: string) => Db } = {}): StoreDbResolution => {
  const url = normalizeDbUrl(options.url) || normalizeDbUrl(resolveAgentsDatabaseConfig().url)
  if (!url) {
    return { db: null, shared: false, url: null }
  }

  if (shouldReuseSharedDb(options)) {
    return { db: getDb(), shared: true, url }
  }

  return { db: (options.createDb ?? createKyselyDb)(url), shared: false, url }
}

export const __private = {
  normalizeDbUrl,
  resolveEffectiveSslMode,
  resolveSslConfig,
  shouldReuseSharedDb,
}
