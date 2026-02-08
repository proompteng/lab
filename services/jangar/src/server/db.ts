import { existsSync, readFileSync } from 'node:fs'

import { type Generated, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

export type Db = Kysely<Database>

type Timestamp = string | Date

type JsonValue = Record<string, unknown>

type AtlasRepositories = {
  id: Generated<string>
  name: string
  default_ref: Generated<string>
  metadata: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AtlasFileKeys = {
  id: Generated<string>
  repository_id: string
  path: string
  created_at: Generated<Timestamp>
}

type AtlasFileVersions = {
  id: Generated<string>
  file_key_id: string
  repository_ref: Generated<string>
  repository_commit: string | null
  content_hash: string
  language: string | null
  byte_size: number | null
  line_count: number | null
  metadata: JsonValue
  source_timestamp: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type AtlasFileChunks = {
  id: Generated<string>
  file_version_id: string
  chunk_index: number
  start_line: number | null
  end_line: number | null
  content: string | null
  token_count: number | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasEnrichments = {
  id: Generated<string>
  file_version_id: string
  chunk_id: string | null
  kind: string
  source: string
  content: string
  summary: string | null
  tags: string[]
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasEmbeddings = {
  id: Generated<string>
  enrichment_id: string
  model: string
  dimension: number
  embedding: unknown
  created_at: Generated<Timestamp>
}

type AtlasTreeSitterFacts = {
  id: Generated<string>
  file_version_id: string
  node_type: string
  match_text: string
  start_line: number | null
  end_line: number | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasSymbols = {
  id: Generated<string>
  repository_id: string
  name: string
  normalized_name: string
  kind: string
  signature: string
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasSymbolDefs = {
  id: Generated<string>
  symbol_id: string
  file_version_id: string
  start_line: number | null
  end_line: number | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasSymbolRefs = {
  id: Generated<string>
  symbol_id: string
  file_version_id: string
  start_line: number | null
  end_line: number | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasFileEdges = {
  id: Generated<string>
  from_file_version_id: string
  to_file_version_id: string
  kind: string
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasGithubEvents = {
  id: Generated<string>
  repository_id: string | null
  delivery_id: string
  event_type: string
  repository: string
  installation_id: string | null
  sender_login: string | null
  payload: JsonValue
  received_at: Generated<Timestamp>
  processed_at: Timestamp | null
}

type AtlasIngestions = {
  id: Generated<string>
  event_id: string
  workflow_id: string
  status: string
  error: string | null
  started_at: Generated<Timestamp>
  finished_at: Timestamp | null
}

type AtlasEventFiles = {
  id: Generated<string>
  event_id: string
  file_key_id: string
  change_type: string
}

type AtlasIngestionTargets = {
  id: Generated<string>
  ingestion_id: string
  file_version_id: string
  kind: string
}

type MemoriesEntries = {
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

type TorghutSymbols = {
  symbol: string
  enabled: Generated<boolean>
  asset_class: Generated<string>
  updated_at: Generated<Timestamp>
}

type TerminalSessions = {
  id: string
  status: string
  worktree_name: string | null
  worktree_path: string | null
  tmux_socket: string | null
  error_message: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  ready_at: Timestamp | null
  closed_at: Timestamp | null
  metadata: JsonValue
}

type JangarGithubEvents = {
  id: Generated<string>
  delivery_id: string
  event_type: string
  action: string | null
  repository: string
  pr_number: number
  commit_sha: string | null
  sender_login: string | null
  payload: JsonValue
  received_at: Generated<Timestamp>
  processed_at: Timestamp | null
}

type JangarGithubPrState = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  title: string | null
  body: string | null
  state: string | null
  merged: boolean | null
  merged_at: Timestamp | null
  draft: boolean | null
  author_login: string | null
  author_avatar_url: string | null
  html_url: string | null
  head_ref: string | null
  head_sha: string | null
  base_ref: string | null
  base_sha: string | null
  mergeable: boolean | null
  mergeable_state: string | null
  labels: string[]
  additions: number | null
  deletions: number | null
  changed_files: number | null
  created_at: Timestamp | null
  updated_at: Timestamp | null
}

type JangarGithubReviewState = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  review_decision: string | null
  requested_changes: boolean | null
  unresolved_threads_count: number | null
  summary: JsonValue
  latest_reviewed_at: Timestamp | null
  updated_at: Timestamp | null
}

type JangarGithubCheckState = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string
  received_at: Timestamp
  status: string | null
  details_url: string | null
  total_count: number | null
  success_count: number | null
  failure_count: number | null
  pending_count: number | null
  checks: JsonValue
  updated_at: Timestamp | null
}

type JangarGithubReviewThreads = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  thread_key: string
  thread_id: string | null
  is_resolved: boolean
  path: string | null
  line: number | null
  side: string | null
  start_line: number | null
  author_login: string | null
  resolved_at: Timestamp | null
  updated_at: Timestamp | null
  created_at: Timestamp | null
}

type JangarGithubComments = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  comment_id: string
  comment_type: string
  thread_key: string | null
  author_login: string | null
  body: string | null
  path: string | null
  line: number | null
  side: string | null
  start_line: number | null
  diff_hunk: string | null
  url: string | null
  created_at: Timestamp | null
  updated_at: Timestamp | null
}

type JangarGithubPrFiles = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string
  received_at: Timestamp
  source: string
  path: string
  status: string | null
  additions: number | null
  deletions: number | null
  changes: number | null
  patch: string | null
  blob_url: string | null
  raw_url: string | null
  sha: string | null
  previous_filename: string | null
}

type JangarGithubPrWorktrees = {
  id: Generated<string>
  repository: string
  pr_number: number
  worktree_name: string
  worktree_path: string
  base_sha: string | null
  head_sha: string | null
  last_refreshed_at: Timestamp
}

type JangarGithubWriteActions = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  action: string
  actor: string | null
  request_id: string | null
  payload: JsonValue
  response: JsonValue | null
  success: boolean
  error: string | null
}

type CodexJudgeRuns = {
  id: Generated<string>
  repository: string
  issue_number: number
  branch: string
  attempt: number
  workflow_name: string
  workflow_uid: string | null
  workflow_namespace: string | null
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

type CodexJudgeArtifacts = {
  id: Generated<string>
  run_id: string
  name: string
  key: string
  bucket: string | null
  url: string | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type CodexJudgeEvaluations = {
  id: Generated<string>
  run_id: string
  decision: string
  confidence: number | null
  reasons: JsonValue
  missing_items: JsonValue
  suggested_fixes: JsonValue
  next_prompt: string | null
  prompt_tuning: JsonValue
  system_suggestions: JsonValue
  created_at: Generated<Timestamp>
}

type CodexJudgePromptTuning = {
  id: Generated<string>
  run_id: string
  pr_url: string
  status: string
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type CodexJudgeRerunSubmissions = {
  id: Generated<string>
  parent_run_id: string
  attempt: number
  delivery_id: string
  status: string
  submission_attempt: Generated<number>
  response_status: number | null
  error: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  submitted_at: Timestamp | null
}

type WorkflowCommsAgentMessage = {
  id: Generated<string>
  workflow_uid: string | null
  workflow_name: string | null
  workflow_namespace: string | null
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

type JangarAgentRuns = {
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

type JangarAgentRunIdempotencyKeys = {
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

type JangarMemoryResources = {
  id: Generated<string>
  memory_name: string
  provider: string
  status: string
  connection_secret: JsonValue | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type JangarOrchestrationRuns = {
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

type JangarAuditEvents = {
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

export type Database = {
  'atlas.repositories': AtlasRepositories
  'atlas.file_keys': AtlasFileKeys
  'atlas.file_versions': AtlasFileVersions
  'atlas.file_chunks': AtlasFileChunks
  'atlas.enrichments': AtlasEnrichments
  'atlas.embeddings': AtlasEmbeddings
  'atlas.tree_sitter_facts': AtlasTreeSitterFacts
  'atlas.symbols': AtlasSymbols
  'atlas.symbol_defs': AtlasSymbolDefs
  'atlas.symbol_refs': AtlasSymbolRefs
  'atlas.file_edges': AtlasFileEdges
  'atlas.github_events': AtlasGithubEvents
  'atlas.ingestions': AtlasIngestions
  'atlas.event_files': AtlasEventFiles
  'atlas.ingestion_targets': AtlasIngestionTargets
  'memories.entries': MemoriesEntries
  torghut_symbols: TorghutSymbols
  'terminals.sessions': TerminalSessions
  'jangar_github.events': JangarGithubEvents
  'jangar_github.pr_state': JangarGithubPrState
  'jangar_github.review_state': JangarGithubReviewState
  'jangar_github.check_state': JangarGithubCheckState
  'jangar_github.review_threads': JangarGithubReviewThreads
  'jangar_github.comments': JangarGithubComments
  'jangar_github.pr_files': JangarGithubPrFiles
  'jangar_github.pr_worktrees': JangarGithubPrWorktrees
  'jangar_github.write_actions': JangarGithubWriteActions
  agent_runs: JangarAgentRuns
  agent_run_idempotency_keys: JangarAgentRunIdempotencyKeys
  memory_resources: JangarMemoryResources
  orchestration_runs: JangarOrchestrationRuns
  audit_events: JangarAuditEvents
  'agents_control_plane.resources_current': AgentsControlPlaneResourcesCurrent
  'codex_judge.runs': CodexJudgeRuns
  'codex_judge.artifacts': CodexJudgeArtifacts
  'codex_judge.evaluations': CodexJudgeEvaluations
  'codex_judge.prompt_tuning': CodexJudgePromptTuning
  'codex_judge.rerun_submissions': CodexJudgeRerunSubmissions
  'workflow_comms.agent_messages': WorkflowCommsAgentMessage
}

let db: Db | null | undefined

const DEFAULT_SSLMODE = 'require'
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_QUERY_TIMEOUT_MS = 20_000

const parsePositiveInt = (rawValue: string | undefined, field: string, fallback: number) => {
  if (!rawValue) return fallback
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
}

const loadCaCert = (rawValue: string) => {
  if (rawValue.includes('BEGIN CERTIFICATE')) {
    return rawValue
  }
  if (existsSync(rawValue)) {
    return readFileSync(rawValue, 'utf8')
  }
  return rawValue
}

const resolveSslMode = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    const mode = url.searchParams.get('sslmode')
    return mode ? mode.trim().toLowerCase() : null
  } catch {
    return null
  }
}

const resolveEffectiveSslMode = (rawUrl: string) => {
  const urlMode = resolveSslMode(rawUrl)
  if (urlMode) return urlMode

  const envMode = process.env.PGSSLMODE?.trim()
  if (envMode) return envMode.toLowerCase()

  return DEFAULT_SSLMODE
}

const resolveSslConfig = (sslmode: string | null, caCertPath?: string) => {
  if (sslmode === 'disable') return undefined

  const requiresVerification = sslmode === 'verify-ca' || sslmode === 'verify-full'
  if (requiresVerification) {
    const ca = caCertPath ? loadCaCert(caCertPath) : undefined
    return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true }
  }

  if (!sslmode && !caCertPath) return undefined
  return { rejectUnauthorized: false }
}

const createDbClient = (rawUrl: string): Db => {
  const url = rawUrl.trim()
  const sslmode = resolveEffectiveSslMode(url)
  const caCertPath = process.env.PGSSLROOTCERT?.trim() || process.env.JANGAR_DB_CA_CERT?.trim()
  const ssl = resolveSslConfig(sslmode, caCertPath)

  const connectionTimeoutMillis = parsePositiveInt(
    process.env.PGCONNECT_TIMEOUT_MS?.trim(),
    'PGCONNECT_TIMEOUT_MS',
    DEFAULT_CONNECT_TIMEOUT_MS,
  )
  const queryTimeoutMillis = parsePositiveInt(
    process.env.PGQUERY_TIMEOUT_MS?.trim(),
    'PGQUERY_TIMEOUT_MS',
    DEFAULT_QUERY_TIMEOUT_MS,
  )

  const pool = new Pool({
    connectionString: url,
    ssl,
    keepAlive: true,
    connectionTimeoutMillis,
    query_timeout: queryTimeoutMillis,
  })

  pool.on('error', (error) => {
    console.warn('[jangar] postgres pool error', error)
  })
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

export const getDb = () => {
  if (db !== undefined) return db

  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    db = null
    return db
  }

  db = createDbClient(url)
  return db
}

export const createKyselyDb = (url: string) => createDbClient(url)

export const __private = {
  resolveEffectiveSslMode,
  resolveSslConfig,
}
