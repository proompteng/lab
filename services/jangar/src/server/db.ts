import { type Generated, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { attachPostgresClientErrorLogger } from './postgres-client-errors'
import { resolveEffectiveSslMode, resolveSslConfig } from './postgres-ssl'
import { resolveDatabaseConfig } from './storage-config'

export type Db = Kysely<Database>
export type StoreDbResolution = {
  db: Db | null
  shared: boolean
  url: string | null
}

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
  text_tsvector: unknown | null
  token_count: number | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
}

type AtlasChunkEmbeddings = {
  chunk_id: string
  model: string
  dimension: number
  embedding: unknown
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
  refresh_failure_reason: string | null
  refresh_failed_at: Timestamp | null
  refresh_blocked_until: Timestamp | null
}

type JangarGithubWriteActions = {
  id: Generated<string>
  repository: string
  pr_number: number
  commit_sha: string | null
  received_at: Timestamp
  mission_id: string | null
  stage: string | null
  action_class: string | null
  action: string
  risk_class: string | null
  rollout_ref: string | null
  rollout_status: string | null
  rollback_ref: string | null
  rollback_reason: string | null
  actor: string | null
  request_id: string | null
  payload: JsonValue
  response: JsonValue | null
  success: boolean
  error: string | null
}

type TorghutQuantMetricsLatest = {
  id: Generated<string>
  strategy_id: string
  account: string
  window: string
  metric_name: string
  status: string
  quality: string
  unit: string
  value_numeric: number | string | null
  value_json: JsonValue
  meta_json: JsonValue
  formula_version: string
  as_of: Timestamp
  freshness_seconds: number
  updated_at: Generated<Timestamp>
}

type TorghutQuantMetricsSeries = {
  id: Generated<string>
  strategy_id: string
  account: string
  window: string
  metric_name: string
  status: string
  quality: string
  unit: string
  value_numeric: number | string | null
  value_json: JsonValue
  meta_json: JsonValue
  formula_version: string
  as_of: Timestamp
  freshness_seconds: number
  created_at: Generated<Timestamp>
}

type TorghutQuantAlerts = {
  id: Generated<string>
  alert_id: string
  strategy_id: string
  account: string
  severity: string
  metric_name: string
  window: string
  threshold_json: JsonValue
  observed_json: JsonValue
  opened_at: Timestamp
  resolved_at: Timestamp | null
  state: string
  updated_at: Generated<Timestamp>
}

type TorghutQuantPipelineHealth = {
  id: Generated<string>
  strategy_id: string
  account: string
  stage: string
  ok: boolean
  lag_seconds: number
  as_of: Timestamp
  details: JsonValue
  created_at: Generated<Timestamp>
}

type TorghutQuantPipelineHealthLatest = {
  strategy_id: string
  account: string
  window: string
  stage: string
  ok: boolean
  lag_seconds: number
  as_of: Timestamp
  details: JsonValue
  updated_at: Generated<Timestamp>
}

type TorghutSimulationRuns = {
  run_id: string
  idempotency_key: string
  workflow_name: string | null
  workflow_uid: string | null
  namespace: string
  status: string
  workflow_phase: string | null
  lane: string
  lane_id: string | null
  profile: string
  cache_policy: string
  cache_key: string | null
  cache_status: string
  priority: string
  run_class: string
  candidate_ref: string | null
  strategy_ref: string | null
  dataset_id: string | null
  artifact_root: string | null
  output_root: string | null
  manifest: JsonValue
  manifest_digest: string
  metadata: JsonValue
  progress: JsonValue
  final_verdict: JsonValue
  submitted_by: string | null
  started_at: Timestamp | null
  finished_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutSimulationRunEvents = {
  id: Generated<string>
  run_id: string
  seq: number
  event_type: string
  payload: JsonValue
  created_at: Generated<Timestamp>
}

type TorghutSimulationArtifacts = {
  id: Generated<string>
  run_id: string
  name: string
  path: string
  kind: string
  metadata: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutSimulationDatasetCache = {
  cache_key: string
  lane: string
  status: string
  window_start: Timestamp | null
  window_end: Timestamp | null
  source_digest: string | null
  schema_digest: string | null
  code_digest: string | null
  dump_format: string
  artifact_path: string | null
  chunk_manifest_path: string | null
  records_total: number
  bytes_total: number
  built_by_run_id: string | null
  expires_at: Timestamp | null
  last_verified_at: Timestamp | null
  metadata: JsonValue
  hit_count: number
  last_used_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutSimulationCampaigns = {
  campaign_id: string
  name: string
  status: string
  request_payload: JsonValue
  summary: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutSimulationCampaignRuns = {
  campaign_id: string
  run_id: string
  candidate_ref: string | null
  window_label: string | null
  created_at: Generated<Timestamp>
}

type TorghutSimulationLaneLeases = {
  lane_id: string
  lane_class: string
  status: string
  run_id: string | null
  cache_key: string | null
  lease_owner: string | null
  lease_expires_at: Timestamp | null
  last_heartbeat_at: Timestamp | null
  metadata: JsonValue
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutMarketContextSnapshots = {
  id: Generated<string>
  symbol: string
  domain: string
  as_of: Timestamp
  source_count: number
  quality_score: number
  payload: JsonValue
  citations: unknown
  risk_flags: string[]
  provider: string
  run_name: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutMarketContextDispatchState = {
  symbol: string
  domain: string
  last_dispatched_at: Timestamp | null
  last_run_name: string | null
  last_status: string
  last_error: string | null
  updated_at: Generated<Timestamp>
}

type TorghutMarketContextRuns = {
  request_id: string
  symbol: string
  domain: string
  run_name: string | null
  provider: string
  reason: string | null
  status: string
  metadata: JsonValue
  error: string | null
  started_at: Generated<Timestamp>
  last_heartbeat_at: Timestamp | null
  finished_at: Timestamp | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

type TorghutMarketContextRunEvents = {
  id: Generated<string>
  request_id: string
  seq: number
  event_type: string
  payload: JsonValue
  created_at: Generated<Timestamp>
}

type TorghutMarketContextEvidence = {
  id: Generated<string>
  request_id: string
  symbol: string
  domain: string
  seq: number
  source: string
  published_at: Timestamp | null
  url: string | null
  headline: string | null
  summary: string | null
  sentiment: string | null
  payload: JsonValue
  digest: string
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
  'atlas.chunk_embeddings': AtlasChunkEmbeddings
  'atlas.tree_sitter_facts': AtlasTreeSitterFacts
  'atlas.symbols': AtlasSymbols
  'atlas.symbol_defs': AtlasSymbolDefs
  'atlas.symbol_refs': AtlasSymbolRefs
  'atlas.file_edges': AtlasFileEdges
  'atlas.github_events': AtlasGithubEvents
  'atlas.ingestions': AtlasIngestions
  'atlas.event_files': AtlasEventFiles
  'atlas.ingestion_targets': AtlasIngestionTargets
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
  'torghut_control_plane.quant_metrics_latest': TorghutQuantMetricsLatest
  'torghut_control_plane.quant_metrics_series': TorghutQuantMetricsSeries
  'torghut_control_plane.quant_alerts': TorghutQuantAlerts
  'torghut_control_plane.quant_pipeline_health': TorghutQuantPipelineHealth
  'torghut_control_plane.quant_pipeline_health_latest': TorghutQuantPipelineHealthLatest
  'torghut_control_plane.simulation_runs': TorghutSimulationRuns
  'torghut_control_plane.simulation_run_events': TorghutSimulationRunEvents
  'torghut_control_plane.simulation_artifacts': TorghutSimulationArtifacts
  'torghut_control_plane.dataset_cache': TorghutSimulationDatasetCache
  'torghut_control_plane.simulation_campaigns': TorghutSimulationCampaigns
  'torghut_control_plane.simulation_campaign_runs': TorghutSimulationCampaignRuns
  'torghut_control_plane.simulation_lane_leases': TorghutSimulationLaneLeases
  torghut_market_context_snapshots: TorghutMarketContextSnapshots
  torghut_market_context_dispatch_state: TorghutMarketContextDispatchState
  torghut_market_context_runs: TorghutMarketContextRuns
  torghut_market_context_run_events: TorghutMarketContextRunEvents
  torghut_market_context_evidence: TorghutMarketContextEvidence
}

let db: Db | null | undefined

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

const createDbClient = (rawUrl: string): Db => {
  const url = rawUrl.trim()
  const sslmode = resolveEffectiveSslMode(url)
  const databaseConfig = resolveDatabaseConfig()
  const caCertPath = databaseConfig.caCertPath ?? undefined
  const ssl = resolveSslConfig(sslmode, caCertPath)

  const connectionTimeoutMillis = databaseConfig.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
  const queryTimeoutMillis = databaseConfig.queryTimeoutMs || DEFAULT_QUERY_TIMEOUT_MS

  const pool = new Pool({
    connectionString: url,
    ssl,
    keepAlive: true,
    max: databaseConfig.poolMax,
    connectionTimeoutMillis,
    query_timeout: queryTimeoutMillis,
  })

  pool.on('error', (error) => {
    console.warn('[jangar] postgres pool error', error)
  })
  pool.on('connect', attachPostgresClientErrorLogger)
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

const normalizeDbUrl = (value: string | undefined) => value?.trim() ?? ''

const shouldReuseSharedDb = (options: { url?: string; createDb?: (url: string) => Db }) => {
  if (options.createDb) return false
  const envUrl = normalizeDbUrl(resolveDatabaseConfig().url ?? undefined)
  const resolvedUrl = normalizeDbUrl(options.url) || envUrl
  return resolvedUrl.length > 0 && resolvedUrl === envUrl
}

export const getDb = () => {
  if (db !== undefined) return db

  const url = normalizeDbUrl(resolveDatabaseConfig().url ?? undefined)
  if (!url) {
    db = null
    return db
  }

  db = createDbClient(url)
  return db
}

export const createKyselyDb = (url: string) => createDbClient(url)

export const resolveStoreDb = (options: { url?: string; createDb?: (url: string) => Db } = {}): StoreDbResolution => {
  const url = normalizeDbUrl(options.url) || normalizeDbUrl(resolveDatabaseConfig().url ?? undefined)
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
