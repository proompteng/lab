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

type MemoryResources = {
  id: Generated<string>
  memory_name: string
  provider: string
  status: string
  connection_secret: JsonValue | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
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

export type AgentsDatabase = {
  agent_runs: AgentRuns
  agent_run_idempotency_keys: AgentRunIdempotencyKeys
  memory_resources: MemoryResources
  orchestration_runs: OrchestrationRuns
  audit_events: AuditEvents
  'agents_control_plane.resources_current': AgentsControlPlaneResourcesCurrent
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
