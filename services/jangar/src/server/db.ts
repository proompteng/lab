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
  'codex_judge.runs': CodexJudgeRuns
  'codex_judge.artifacts': CodexJudgeArtifacts
  'codex_judge.evaluations': CodexJudgeEvaluations
  'codex_judge.prompt_tuning': CodexJudgePromptTuning
  'codex_judge.rerun_submissions': CodexJudgeRerunSubmissions
  'workflow_comms.agent_messages': WorkflowCommsAgentMessage
}

let db: Db | null | undefined

const DEFAULT_SSLMODE = 'require'

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

  const pool = new Pool({ connectionString: url, ssl })
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
