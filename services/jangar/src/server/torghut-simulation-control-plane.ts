import { createHash, randomUUID } from 'node:crypto'
import { posix as pathPosix } from 'node:path'

import { stableJsonStringifyForHash } from '~/server/agents-controller/template-hash'
import { getDb } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'
import { createKubernetesClient } from '~/server/primitives-kube'
import { resolveTorghutSimulationStorageConfig } from './torghut-config'

type JsonRecord = Record<string, unknown>

export type TorghutSimulationRunRequest = {
  runId?: string
  manifest: JsonRecord
  forceReplay?: boolean
  forceDump?: boolean
  allowMissingState?: boolean
  outputRoot?: string
  priority?: string
  cachePolicy?: string
  profile?: string
  submittedBy?: string | null
  metadata?: JsonRecord
}

export type TorghutSimulationCampaignRequest = {
  campaignId?: string
  name?: string
  manifest: JsonRecord
  windows: Array<{
    start: string
    end: string
    label?: string | null
  }>
  candidateRef?: string | null
  candidateRefs?: string[]
  baselineCandidateRef?: string | null
  strategyRef?: string | null
  windowSetRef?: string | null
  simulationProfile?: string | null
  costModelVersion?: string | null
  artifactRoot?: string | null
  gateConfigRef?: string | null
  campaignMode?: string | null
  stressProfile?: JsonRecord | null
  priority?: string
  cachePolicy?: string
  profile?: string
  submittedBy?: string | null
}

export type TorghutSimulationRunSnapshot = {
  runId: string
  workflowName: string | null
  namespace: string
  status: string
  workflowPhase: string | null
  lane: string
  laneId: string | null
  profile: string
  cachePolicy: string
  cacheKey: string | null
  cacheStatus: string
  priority: string
  runClass: string
  candidateRef: string | null
  strategyRef: string | null
  datasetId: string | null
  artifactRoot: string | null
  outputRoot: string | null
  manifest: JsonRecord
  metadata: JsonRecord
  progress: JsonRecord
  finalVerdict: JsonRecord
  submittedBy: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type TorghutSimulationArtifactRecord = {
  name: string
  path: string
  kind: string
  metadata: JsonRecord
  updatedAt: string
}

export type TorghutSimulationCampaignSnapshot = {
  campaignId: string
  name: string
  status: string
  requestPayload: JsonRecord
  summary: JsonRecord
  createdAt: string
  updatedAt: string
}

export type TorghutSimulationPreset = {
  id: string
  name: string
  description: string
  profile: string
  cachePolicy: string
  manifest: JsonRecord
}

const DEFAULT_TORGHUT_NAMESPACE = 'torghut'
const DEFAULT_WORKFLOW_NAMESPACE = 'argo-workflows'
const DEFAULT_OUTPUT_ROOT = 'artifacts/torghut/simulations'
const DEFAULT_WORKFLOW_OUTPUT_ROOT = '/tmp/torghut-simulations'
const DEFAULT_PRIORITY = 'interactive'
const DEFAULT_PROFILE = 'smoke'
const DEFAULT_CACHE_POLICY = 'prefer_cache'
const DEFAULT_CONFIRM_PHRASE = 'START_HISTORICAL_SIMULATION'
const DEFAULT_WORKFLOW_TEMPLATE_NAME = 'torghut-historical-simulation'
const DEFAULT_DUMP_FORMAT = 'jsonl.zst'
const DEFAULT_CAMPAIGN_OUTPUT_ROOT = `${DEFAULT_OUTPUT_ROOT}/campaigns`
const simulationStorageConfig = resolveTorghutSimulationStorageConfig(process.env)
const DEFAULT_SIMULATION_CACHE_BUCKET = simulationStorageConfig.cacheBucket
const DEFAULT_SIMULATION_CACHE_PREFIX = simulationStorageConfig.cachePrefix
const DEFAULT_SIMULATION_KAFKA_BOOTSTRAP = 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9092'
const DEFAULT_SIMULATION_KAFKA_USERNAME = 'kafka-codex-credentials'
const DEFAULT_SIMULATION_KAFKA_PASSWORD_ENV = 'TORGHUT_SIM_KAFKA_PASSWORD'
const DEFAULT_SIMULATION_CLICKHOUSE_HTTP_URL = 'http://torghut-clickhouse.torghut.svc.cluster.local:8123'
const DEFAULT_SIMULATION_CLICKHOUSE_USERNAME = 'torghut'
const DEFAULT_SIMULATION_CLICKHOUSE_PASSWORD_ENV = 'TORGHUT_CLICKHOUSE_PASSWORD'
const DEFAULT_SIMULATION_POSTGRES_HOST = 'torghut-db-rw.torghut.svc.cluster.local:5432'
const DEFAULT_SIMULATION_POSTGRES_ADMIN_DSN = `postgresql://postgres@${DEFAULT_SIMULATION_POSTGRES_HOST}/postgres`
const DEFAULT_SIMULATION_POSTGRES_ADMIN_PASSWORD_ENV = 'TORGHUT_POSTGRES_ADMIN_PASSWORD'
const DEFAULT_SIMULATION_POSTGRES_RUNTIME_USER = 'torghut_app'
const DEFAULT_SIMULATION_POSTGRES_MIGRATIONS_COMMAND = '/opt/venv/bin/alembic upgrade heads'
const DEFAULT_WARM_LANE_DATABASE = 'torghut_sim_default'
const DEFAULT_RUNTIME_VERSION_REFS = ['services/torghut@simulation'] as const
const DEFAULT_ROLLOUTS_NAMESPACE = 'torghut'
const DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE = 'torghut-simulation-runtime-ready'
const DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE = 'torghut-simulation-activity'
const DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE = 'torghut-simulation-teardown-clean'
const DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE = 'torghut-simulation-artifact-bundle'
const DEFAULT_EXPECTED_ARTIFACTS = [
  'run-manifest.json',
  'runtime-verify.json',
  'replay-report.json',
  'activity-debug.json',
  'signal-activity.json',
  'decision-activity.json',
  'execution-activity.json',
  'strategy-proof.json',
  'performance.json',
  'run-summary.json',
  'gate-input.json',
  'completion-trace.json',
  'source-dump',
] as const

const DEFAULT_SIMULATION_PRESETS: TorghutSimulationPreset[] = [
  {
    id: 'tsmom-compact-proof',
    name: 'TSMOM Compact Proof',
    description: 'Fast interactive replay for proving a candidate on a compact open-window slice.',
    profile: 'compact',
    cachePolicy: 'prefer_cache',
    manifest: {
      dataset_id: 'torghut-smoke-open-hour-20260306',
      candidate_id: 'intraday_tsmom_v1@prod',
      baseline_candidate_id: 'intraday_tsmom_v1@baseline',
      strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
      model_refs: ['rules/intraday_tsmom_v1'],
      window: {
        start: '2026-03-06T14:30:00Z',
        end: '2026-03-06T14:45:00Z',
      },
      performance: {
        replayProfile: 'compact',
        dumpFormat: 'jsonl.zst',
      },
      cachePolicy: 'prefer_cache',
    },
  },
  {
    id: 'tsmom-open-hour',
    name: 'TSMOM Open Hour',
    description: 'Standard one-hour replay for end-to-end execution evidence on the default TSMOM candidate.',
    profile: 'hourly',
    cachePolicy: 'prefer_cache',
    manifest: {
      dataset_id: 'torghut-smoke-open-hour-20260306',
      candidate_id: 'intraday_tsmom_v1@prod',
      baseline_candidate_id: 'intraday_tsmom_v1@baseline',
      strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
      model_refs: ['rules/intraday_tsmom_v1'],
      window: {
        start: '2026-03-06T14:30:00Z',
        end: '2026-03-06T15:30:00Z',
      },
      performance: {
        replayProfile: 'hourly',
        dumpFormat: 'jsonl.zst',
      },
      cachePolicy: 'prefer_cache',
    },
  },
  {
    id: 'tsmom-autonomy-robustness',
    name: 'TSMOM Robustness Campaign',
    description: 'Multi-window replay preset intended for Jangar-driven autonomy and profitability comparisons.',
    profile: 'hourly',
    cachePolicy: 'prefer_cache',
    manifest: {
      dataset_id: 'torghut-smoke-open-hour-20260306',
      candidate_id: 'intraday_tsmom_v1@candidate',
      baseline_candidate_id: 'intraday_tsmom_v1@baseline',
      strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
      model_refs: ['rules/intraday_tsmom_v1'],
      window: {
        start: '2026-03-06T14:30:00Z',
        end: '2026-03-06T15:30:00Z',
      },
      performance: {
        replayProfile: 'hourly',
        dumpFormat: 'jsonl.zst',
      },
      cachePolicy: 'prefer_cache',
      campaign: {
        windows: [
          { start: '2026-03-06T14:30:00Z', end: '2026-03-06T15:30:00Z', label: 'open-hour-1' },
          { start: '2026-03-07T14:30:00Z', end: '2026-03-07T15:30:00Z', label: 'open-hour-2' },
        ],
      },
    },
  },
]

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const INTERACTIVE_LANES = ['sim-fast-1'] as const
const BATCH_LANES = ['sim-fast-1'] as const
const CONTROL_PLANE_LEASE_OWNER = 'jangar-control-plane'
const PROGRESS_FETCH_TIMEOUT_MS = 2_500
const SIMULATION_CACHE_KEY_SCHEMA_VERSION = 'torghut-simulation-cache-v2'

const defaultTaRestoreMode = (_profile: string) => 'stateless'

const resolveRunClass = (profile: string, priority: string) => {
  const normalizedProfile = profile.trim().toLowerCase()
  const normalizedPriority = priority.trim().toLowerCase()
  return normalizedProfile === 'full_day' || normalizedPriority === 'batch' ? 'batch' : 'interactive'
}

const resolveLaneIds = (runClass: string) => (runClass === 'batch' ? BATCH_LANES : INTERACTIVE_LANES)

const resolveSimulationServiceName = (manifest: JsonRecord) => {
  const runtime = asRecord(manifest.runtime)
  const targetMode = (asString(runtime.target_mode) ?? 'dedicated_service').toLowerCase()
  if (asString(runtime.torghut_service)) return String(runtime.torghut_service)
  return targetMode === 'in_place' ? 'torghut' : 'torghut-sim'
}

const resolveSimulationNamespace = (manifest: JsonRecord) => {
  const runtime = asRecord(manifest.runtime)
  return asString(runtime.namespace) ?? DEFAULT_TORGHUT_NAMESPACE
}

const resolveSimulationWorkflowNamespace = (manifest: JsonRecord) => {
  const runtime = asRecord(manifest.runtime)
  return asString(runtime.workflow_namespace) ?? DEFAULT_WORKFLOW_NAMESPACE
}

const stableStringList = (value: unknown) =>
  [
    ...new Set(
      asArray(value)
        .map((item) => asString(item)?.trim())
        .filter((item): item is string => Boolean(item)),
    ),
  ].sort()

const buildSimulationCacheKey = (manifest: JsonRecord, profile: string) =>
  createHash('sha256')
    .update(
      stableJsonStringifyForHash({
        schema_version: SIMULATION_CACHE_KEY_SCHEMA_VERSION,
        lane: asString(manifest.lane) ?? 'equity',
        dataset_id: asString(manifest.dataset_id),
        dataset_snapshot_ref: asString(manifest.dataset_snapshot_ref) ?? asString(manifest.dataset_id),
        window: asRecord(manifest.window),
        strategy_spec_ref: asString(manifest.strategy_spec_ref),
        candidate_id: asString(manifest.candidate_id),
        baseline_candidate_id: asString(manifest.baseline_candidate_id),
        model_refs: stableStringList(manifest.model_refs),
        runtime_version_refs: stableStringList(manifest.runtime_version_refs),
        dump_format: asString(asRecord(manifest.performance).dumpFormat) ?? DEFAULT_DUMP_FORMAT,
        profile,
      }),
    )
    .digest('hex')

const resolveWorkflowOutputRoot = (outputRoot: string) => {
  const normalized = outputRoot.trim().replace(/\/+$/, '')
  if (!normalized) return DEFAULT_WORKFLOW_OUTPUT_ROOT
  if (normalized.startsWith('/')) return normalized
  return pathPosix.join(DEFAULT_WORKFLOW_OUTPUT_ROOT, normalized)
}

const dumpSuffixForFormat = (dumpFormat: string) =>
  dumpFormat === 'jsonl.gz' ? '.jsonl.gz' : dumpFormat === 'jsonl.zst' ? '.jsonl.zst' : '.ndjson'

const buildDatasetCacheArtifactPaths = (cacheKey: string, dumpFormat: string) => {
  const objectKey = pathPosix.join(
    DEFAULT_SIMULATION_CACHE_PREFIX,
    cacheKey,
    `source-dump${dumpSuffixForFormat(dumpFormat)}`,
  )
  return {
    artifactPath: `s3://${DEFAULT_SIMULATION_CACHE_BUCKET}/${objectKey}`,
    chunkManifestPath: `s3://${DEFAULT_SIMULATION_CACHE_BUCKET}/${objectKey}.manifest.json`,
  }
}

const reserveSimulationLane = async (params: { runId: string; runClass: string; cacheKey: string | null }) => {
  const db = await ensureDb()
  await reconcileSimulationLaneLeases(db)
  const laneIds = resolveLaneIds(params.runClass)
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1000)

  for (const laneId of laneIds) {
    const result = await db
      .updateTable('torghut_control_plane.simulation_lane_leases')
      .set({
        status: 'reserved',
        run_id: params.runId,
        cache_key: params.cacheKey,
        lease_owner: CONTROL_PLANE_LEASE_OWNER,
        lease_expires_at: leaseExpiresAt,
        last_heartbeat_at: now,
        updated_at: now,
        metadata: {
          reservedAt: now.toISOString(),
          reservedBy: CONTROL_PLANE_LEASE_OWNER,
        },
      })
      .where('lane_id', '=', laneId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'available'),
          eb('run_id', '=', params.runId),
          eb('lease_expires_at', 'is', null),
          eb('lease_expires_at', '<', now),
        ]),
      )
      .executeTakeFirst()
    if (Number(result.numUpdatedRows ?? 0) > 0) {
      return {
        laneId,
        leaseExpiresAt,
      }
    }
  }

  throw new Error(`no simulation lane available for run_class=${params.runClass}`)
}

const releaseSimulationLane = async (runId: string) => {
  const db = await ensureDb()
  await db
    .updateTable('torghut_control_plane.simulation_lane_leases')
    .set({
      status: 'available',
      run_id: null,
      cache_key: null,
      lease_owner: null,
      lease_expires_at: null,
      last_heartbeat_at: new Date(),
      updated_at: new Date(),
      metadata: {
        releasedAt: new Date().toISOString(),
        releasedBy: CONTROL_PLANE_LEASE_OWNER,
      },
    })
    .where('run_id', '=', runId)
    .execute()
}

const upsertDatasetCache = async (params: {
  cacheKey: string
  lane: string
  manifest: JsonRecord
  profile: string
  runId: string
  status: string
}) => {
  const db = await ensureDb()
  const performance = asRecord(params.manifest.performance)
  const window = asRecord(params.manifest.window)
  const dumpFormat = asString(performance.dumpFormat) ?? DEFAULT_DUMP_FORMAT
  const cachePaths = buildDatasetCacheArtifactPaths(params.cacheKey, dumpFormat)
  await db
    .insertInto('torghut_control_plane.dataset_cache')
    .values({
      cache_key: params.cacheKey,
      lane: params.lane,
      status: params.status,
      window_start: asString(window.start) ? new Date(String(window.start)) : null,
      window_end: asString(window.end) ? new Date(String(window.end)) : null,
      source_digest: asString(params.manifest.dataset_id),
      schema_digest: asString(params.manifest.strategy_spec_ref),
      code_digest: asString(asRecord(params.manifest.metadata).imageDigest),
      dump_format: dumpFormat,
      artifact_path: cachePaths.artifactPath,
      chunk_manifest_path: cachePaths.chunkManifestPath,
      records_total: 0,
      bytes_total: 0,
      built_by_run_id: params.runId,
      expires_at: null,
      last_verified_at: null,
      metadata: {
        replayProfile: params.profile,
        storage: 'durable_ceph_s3',
      },
      hit_count: 0,
      last_used_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('cache_key').doUpdateSet({
        status: params.status,
        artifact_path: cachePaths.artifactPath,
        chunk_manifest_path: cachePaths.chunkManifestPath,
        built_by_run_id: params.runId,
        metadata: {
          replayProfile: params.profile,
          storage: 'durable_ceph_s3',
        },
        last_used_at: new Date(),
        updated_at: new Date(),
      }),
    )
    .execute()
}

const touchDatasetCacheHit = async (cacheKey: string) => {
  const db = await ensureDb()
  const existing = await db
    .selectFrom('torghut_control_plane.dataset_cache')
    .selectAll()
    .where('cache_key', '=', cacheKey)
    .executeTakeFirst()
  if (!existing) return

  await db
    .updateTable('torghut_control_plane.dataset_cache')
    .set({
      hit_count: Number(existing.hit_count ?? 0) + 1,
      last_used_at: new Date(),
      updated_at: new Date(),
    })
    .where('cache_key', '=', cacheKey)
    .execute()
}

const fetchSimulationProgress = async (run: TorghutSimulationRunSnapshot) => {
  const serviceName = resolveSimulationServiceName(run.manifest)
  const namespace = resolveSimulationNamespace(run.manifest)
  const url = `http://${serviceName}.${namespace}.svc.cluster.local/trading/simulation/progress?run_id=${encodeURIComponent(
    run.runId,
  )}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROGRESS_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const payload = (await response.json().catch(() => null)) as JsonRecord | null
    return payload
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const deriveFinalVerdict = (run: TorghutSimulationRunSnapshot, progress: JsonRecord) => {
  const summary = asRecord(progress.summary)
  const executions = Number(summary.executions ?? 0)
  const orderEvents = Number(summary.execution_order_events ?? 0)
  const tca = Number(summary.execution_tca_metrics ?? 0)
  const decisions = Number(summary.trade_decisions ?? 0)
  const legacyPathCount = Number(summary.legacy_path_count ?? 0)
  const authoritativeSuccess =
    run.status === 'succeeded' && decisions > 0 && executions > 0 && tca > 0 && orderEvents > 0 && legacyPathCount === 0
  return {
    authoritative: TERMINAL_RUN_STATUSES.has(run.status),
    status: authoritativeSuccess ? 'success' : run.status,
    decisions,
    executions,
    executionTcaMetrics: tca,
    executionOrderEvents: orderEvents,
    activityClassification: asString(summary.activity_classification),
    legacyPathCount,
    imageDigest: asString(asRecord(progress.summary).image_digest) ?? asString(asRecord(run.metadata).imageDigest),
    updatedAt: new Date().toISOString(),
  }
}

const asRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonRecord
}

const asArray = (value: unknown) => (Array.isArray(value) ? value : [])

const asString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const asBoolean = (value: unknown, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

const campaignSnapshotFromRow = (row: Record<string, unknown>): TorghutSimulationCampaignSnapshot => ({
  campaignId: String(row.campaign_id),
  name: String(row.name),
  status: String(row.status),
  requestPayload: asRecord(row.request_payload),
  summary: asRecord(row.summary),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

const normalizeRunToken = (value: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  if (!normalized) throw new Error('runId must contain at least one alphanumeric character')
  return normalized
}

const candidateToken = (value: string) => normalizeRunToken(value).slice(0, 48)

const buildCampaignRunId = (
  campaignId: string,
  candidateRef: string,
  windowSpec: { start: string; end: string; label?: string | null },
) => {
  const startToken = normalizeRunToken(windowSpec.start.replace(/[:.]/g, '-')).slice(0, 32)
  const labelToken = asString(windowSpec.label) ? `-${normalizeRunToken(String(windowSpec.label)).slice(0, 24)}` : ''
  return `${normalizeRunToken(campaignId)}-${candidateToken(candidateRef)}-${startToken}${labelToken}`.slice(0, 120)
}

const defaultSimulationDatabaseName = (runIdSeed: string, useWarmLane: boolean) =>
  useWarmLane ? DEFAULT_WARM_LANE_DATABASE : `torghut_sim_${normalizeRunToken(runIdSeed)}`

const defaultSimulationPostgresDsn = (database: string) =>
  `postgresql://${DEFAULT_SIMULATION_POSTGRES_RUNTIME_USER}@${DEFAULT_SIMULATION_POSTGRES_HOST}/${database}`

const replaceDatabaseInDsn = (dsn: string, database: string) => {
  const parsed = new URL(dsn)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

const parseTimestamp = (value: unknown) => {
  const text = asString(value)
  if (!text) return null
  return text
}

const normalizeSimulationManifest = (
  manifestInput: JsonRecord,
  overrides: Pick<TorghutSimulationRunRequest, 'runId' | 'outputRoot' | 'cachePolicy' | 'profile'>,
) => {
  const manifest = structuredClone(manifestInput)
  const window = asRecord(manifest.window)
  if (!asString(manifest.dataset_id)) throw new Error('manifest.dataset_id is required')
  if (!asString(window.start)) throw new Error('manifest.window.start is required')
  if (!asString(window.end)) throw new Error('manifest.window.end is required')

  const runtime = asRecord(manifest.runtime)
  const targetMode = (asString(runtime.target_mode) ?? 'dedicated_service').toLowerCase()
  runtime.target_mode = targetMode
  if (overrides.outputRoot) runtime.output_root = overrides.outputRoot
  if (!asString(runtime.output_root)) runtime.output_root = DEFAULT_OUTPUT_ROOT
  if (runtime.use_warm_lane === undefined && runtime.useWarmLane === undefined) {
    const lane = (asString(manifest.lane) ?? 'equity').toLowerCase()
    runtime.use_warm_lane = targetMode === 'dedicated_service' && lane === 'equity'
  }
  manifest.runtime = runtime
  const useWarmLane = Boolean(runtime.use_warm_lane ?? runtime.useWarmLane)
  const runIdSeed = overrides.runId ?? `${String(manifest.dataset_id)}-${String(window.start)}-${String(window.end)}`
  const simulationDatabase = defaultSimulationDatabaseName(runIdSeed, useWarmLane)

  const performance = asRecord(manifest.performance)
  if (overrides.profile) performance.replayProfile = overrides.profile
  if (!asString(performance.replayProfile)) performance.replayProfile = DEFAULT_PROFILE
  if (!asString(performance.dumpFormat)) performance.dumpFormat = DEFAULT_DUMP_FORMAT
  manifest.performance = performance

  const taRestore = asRecord(manifest.ta_restore)
  if (!asString(taRestore.mode)) taRestore.mode = defaultTaRestoreMode(String(performance.replayProfile))
  manifest.ta_restore = taRestore

  if (overrides.cachePolicy) {
    manifest.cachePolicy = overrides.cachePolicy
  } else if (!asString(manifest.cachePolicy)) {
    manifest.cachePolicy = DEFAULT_CACHE_POLICY
  }

  const kafka = asRecord(manifest.kafka)
  if (!asString(kafka.bootstrap_servers)) kafka.bootstrap_servers = DEFAULT_SIMULATION_KAFKA_BOOTSTRAP
  if (!asString(kafka.runtime_bootstrap_servers)) kafka.runtime_bootstrap_servers = kafka.bootstrap_servers
  if (!asString(kafka.security_protocol)) kafka.security_protocol = 'SASL_PLAINTEXT'
  if (!asString(kafka.sasl_mechanism)) kafka.sasl_mechanism = 'SCRAM-SHA-512'
  if (!asString(kafka.sasl_username)) kafka.sasl_username = DEFAULT_SIMULATION_KAFKA_USERNAME
  if (!asString(kafka.sasl_password_env)) kafka.sasl_password_env = DEFAULT_SIMULATION_KAFKA_PASSWORD_ENV
  if (!asString(kafka.runtime_security_protocol)) kafka.runtime_security_protocol = kafka.security_protocol
  if (!asString(kafka.runtime_sasl_mechanism)) kafka.runtime_sasl_mechanism = kafka.sasl_mechanism
  if (!asString(kafka.runtime_sasl_username)) kafka.runtime_sasl_username = kafka.sasl_username
  if (!asString(kafka.runtime_sasl_password_env)) kafka.runtime_sasl_password_env = kafka.sasl_password_env
  if (!asString(kafka.default_partitions)) kafka.default_partitions = 8
  if (!asString(kafka.replication_factor)) kafka.replication_factor = 1
  manifest.kafka = kafka

  const clickhouse = asRecord(manifest.clickhouse)
  if (!asString(clickhouse.http_url)) clickhouse.http_url = DEFAULT_SIMULATION_CLICKHOUSE_HTTP_URL
  if (!asString(clickhouse.username)) clickhouse.username = DEFAULT_SIMULATION_CLICKHOUSE_USERNAME
  if (!asString(clickhouse.password_env)) clickhouse.password_env = DEFAULT_SIMULATION_CLICKHOUSE_PASSWORD_ENV
  if (useWarmLane || !asString(clickhouse.simulation_database)) {
    clickhouse.simulation_database = simulationDatabase
  }
  manifest.clickhouse = clickhouse

  const postgres = asRecord(manifest.postgres)
  if (!asString(postgres.admin_dsn)) postgres.admin_dsn = DEFAULT_SIMULATION_POSTGRES_ADMIN_DSN
  if (!asString(postgres.admin_dsn_password_env)) {
    postgres.admin_dsn_password_env = DEFAULT_SIMULATION_POSTGRES_ADMIN_PASSWORD_ENV
  }
  if (!asString(postgres.simulation_dsn)) {
    postgres.simulation_dsn = defaultSimulationPostgresDsn(simulationDatabase)
  } else if (useWarmLane) {
    postgres.simulation_dsn = replaceDatabaseInDsn(String(postgres.simulation_dsn), simulationDatabase)
  }
  if (!asString(postgres.runtime_simulation_dsn)) {
    postgres.runtime_simulation_dsn = defaultSimulationPostgresDsn(simulationDatabase)
  } else if (useWarmLane) {
    postgres.runtime_simulation_dsn = replaceDatabaseInDsn(String(postgres.runtime_simulation_dsn), simulationDatabase)
  }
  if (!asString(postgres.migrations_command)) {
    postgres.migrations_command = DEFAULT_SIMULATION_POSTGRES_MIGRATIONS_COMMAND
  }
  manifest.postgres = postgres

  if (!Array.isArray(manifest.runtime_version_refs)) {
    manifest.runtime_version_refs = [...DEFAULT_RUNTIME_VERSION_REFS]
  }

  const rollouts = asRecord(manifest.rollouts)
  if (rollouts.enabled === undefined) rollouts.enabled = true
  if (!asString(rollouts.namespace)) rollouts.namespace = DEFAULT_ROLLOUTS_NAMESPACE
  if (!asString(rollouts.runtime_template)) rollouts.runtime_template = DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE
  if (!asString(rollouts.activity_template)) rollouts.activity_template = DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE
  if (!asString(rollouts.teardown_template)) rollouts.teardown_template = DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE
  if (!asString(rollouts.artifact_template)) rollouts.artifact_template = DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE
  manifest.rollouts = rollouts

  const argocd = asRecord(manifest.argocd)
  if (argocd.manage_automation === undefined) argocd.manage_automation = true
  if (!asString(argocd.applicationset_name)) argocd.applicationset_name = 'product'
  if (!asString(argocd.applicationset_namespace)) argocd.applicationset_namespace = 'argocd'
  if (!asString(argocd.app_name)) argocd.app_name = 'torghut'
  if (!asString(argocd.desired_mode_during_run)) argocd.desired_mode_during_run = 'manual'
  if (!asString(argocd.restore_mode_after_run)) argocd.restore_mode_after_run = 'previous'
  manifest.argocd = argocd

  return manifest
}

const reconcileSimulationLaneLeases = async (db: Awaited<ReturnType<typeof ensureDb>>) => {
  const now = new Date()
  const lanes = await db.selectFrom('torghut_control_plane.simulation_lane_leases').selectAll().execute()

  for (const lane of lanes) {
    const laneRow = lane as Record<string, unknown>
    const runId = asString(laneRow.run_id)
    const leaseExpiresAt = asString(laneRow.lease_expires_at)
    const expired = leaseExpiresAt ? new Date(leaseExpiresAt).getTime() <= now.getTime() : false
    let terminal = false

    if (runId) {
      const run = await db
        .selectFrom('torghut_control_plane.simulation_runs')
        .selectAll()
        .where('run_id', '=', runId)
        .executeTakeFirst()
      terminal = Boolean(run && TERMINAL_RUN_STATUSES.has(String((run as Record<string, unknown>).status)))
    }

    if (!expired && !terminal) continue

    await db
      .updateTable('torghut_control_plane.simulation_lane_leases')
      .set({
        status: 'available',
        run_id: null,
        cache_key: null,
        lease_owner: null,
        lease_expires_at: null,
        last_heartbeat_at: now,
        updated_at: now,
        metadata: {
          releasedAt: now.toISOString(),
          releasedBy: CONTROL_PLANE_LEASE_OWNER,
          releaseReason: terminal ? 'run_terminal' : 'lease_expired',
        },
      })
      .where('lane_id', '=', String(laneRow.lane_id))
      .execute()
  }
}

const buildRobustnessScorecard = (runs: TorghutSimulationRunSnapshot[]) => {
  const totals = {
    runs: runs.length,
    authoritativeSuccesses: 0,
    failed: 0,
    cancelled: 0,
  }
  const candidates = new Map<
    string,
    {
      runCount: number
      authoritativeSuccesses: number
      decisions: number
      executions: number
      executionTcaMetrics: number
      executionOrderEvents: number
    }
  >()

  for (const run of runs) {
    const finalVerdict = asRecord(run.finalVerdict)
    const decisions = Number(finalVerdict.decisions ?? 0)
    const executions = Number(finalVerdict.executions ?? 0)
    const executionTcaMetrics = Number(finalVerdict.executionTcaMetrics ?? 0)
    const executionOrderEvents = Number(finalVerdict.executionOrderEvents ?? 0)
    const candidateKey = run.candidateRef ?? 'unknown'
    const entry = candidates.get(candidateKey) ?? {
      runCount: 0,
      authoritativeSuccesses: 0,
      decisions: 0,
      executions: 0,
      executionTcaMetrics: 0,
      executionOrderEvents: 0,
    }
    entry.runCount += 1
    entry.decisions += decisions
    entry.executions += executions
    entry.executionTcaMetrics += executionTcaMetrics
    entry.executionOrderEvents += executionOrderEvents
    if (finalVerdict.status === 'success') {
      entry.authoritativeSuccesses += 1
      totals.authoritativeSuccesses += 1
    } else if (run.status === 'failed') {
      totals.failed += 1
    } else if (run.status === 'cancelled') {
      totals.cancelled += 1
    }
    candidates.set(candidateKey, entry)
  }

  return {
    schemaVersion: 'robustness-scorecard-v1',
    generatedAt: new Date().toISOString(),
    totals,
    candidates: Object.fromEntries(
      [...candidates.entries()].map(([candidateRef, entry]) => [
        candidateRef,
        {
          ...entry,
          executionRate: entry.runCount > 0 ? entry.executions / entry.runCount : 0,
        },
      ]),
    ),
  }
}

const campaignSummaryFromRuns = (
  request: TorghutSimulationCampaignRequest,
  runs: TorghutSimulationRunSnapshot[],
  statusOverride?: string,
): JsonRecord => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  }
  return {
    totalRuns: runs.length,
    statuses: Object.fromEntries(counts),
    runIds: runs.map((run) => run.runId),
    candidateRef: request.candidateRef ?? null,
    candidateRefs: request.candidateRefs ?? [],
    windows: request.windows,
    baselineCandidateRef: request.baselineCandidateRef ?? null,
    strategyRef: request.strategyRef ?? null,
    windowSetRef: request.windowSetRef ?? null,
    simulationProfile: request.simulationProfile ?? null,
    costModelVersion: request.costModelVersion ?? null,
    artifactRoot: request.artifactRoot ?? null,
    gateConfigRef: request.gateConfigRef ?? null,
    campaignMode: request.campaignMode ?? null,
    stressProfile: request.stressProfile ?? null,
    statusOverride: statusOverride ?? null,
    robustnessScorecard: buildRobustnessScorecard(runs),
  }
}

const normalizeCampaignRequest = (request: TorghutSimulationCampaignRequest) => {
  const manifest = structuredClone(request.manifest)
  const candidateRef = request.candidateRef ?? asString(manifest.candidate_id)
  const candidateRefs =
    request.candidateRefs && request.candidateRefs.length > 0
      ? request.candidateRefs
      : [candidateRef ?? 'intraday_tsmom_v1@candidate']
  const profile = request.profile ?? request.simulationProfile ?? DEFAULT_PROFILE
  return {
    campaignId: request.campaignId ?? `campaign-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`,
    name: request.name ?? 'Torghut Simulation Campaign',
    manifest,
    windows: request.windows,
    candidateRef,
    candidateRefs,
    baselineCandidateRef: request.baselineCandidateRef ?? asString(manifest.baseline_candidate_id),
    strategyRef: request.strategyRef ?? asString(manifest.strategy_spec_ref),
    windowSetRef: request.windowSetRef ?? asString(asRecord(manifest.campaign).windowSetRef),
    simulationProfile: request.simulationProfile ?? profile,
    costModelVersion: request.costModelVersion ?? asString(manifest.cost_model_version),
    artifactRoot: request.artifactRoot ?? asString(asRecord(manifest.runtime).output_root),
    gateConfigRef: request.gateConfigRef ?? asString(asRecord(manifest.campaign).gateConfigRef),
    campaignMode: request.campaignMode ?? 'baseline_vs_candidate',
    stressProfile:
      request.stressProfile ?? (asRecord(manifest.campaign).stressProfile as JsonRecord | undefined) ?? null,
    priority: request.priority ?? DEFAULT_PRIORITY,
    cachePolicy: request.cachePolicy ?? DEFAULT_CACHE_POLICY,
    profile,
    submittedBy: request.submittedBy ?? null,
  }
}

const snapshotFromRow = (row: Record<string, unknown>): TorghutSimulationRunSnapshot => ({
  runId: String(row.run_id),
  workflowName: asString(row.workflow_name),
  namespace: String(row.namespace),
  status: String(row.status),
  workflowPhase: asString(row.workflow_phase),
  lane: String(row.lane),
  laneId: asString(row.lane_id),
  profile: String(row.profile),
  cachePolicy: String(row.cache_policy),
  cacheKey: asString(row.cache_key),
  cacheStatus: String(row.cache_status ?? 'unknown'),
  priority: String(row.priority),
  runClass: String(row.run_class ?? 'interactive'),
  candidateRef: asString(row.candidate_ref),
  strategyRef: asString(row.strategy_ref),
  datasetId: asString(row.dataset_id),
  artifactRoot: asString(row.artifact_root),
  outputRoot: asString(row.output_root),
  manifest: asRecord(row.manifest),
  metadata: asRecord(row.metadata),
  progress: asRecord(row.progress),
  finalVerdict: asRecord(row.final_verdict),
  submittedBy: asString(row.submitted_by),
  startedAt: parseTimestamp(row.started_at),
  finishedAt: parseTimestamp(row.finished_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

const manifestDigest = (manifest: JsonRecord) =>
  createHash('sha256').update(stableJsonStringifyForHash(manifest)).digest('hex')

const expectedArtifactsForRun = (runId: string, outputRoot: string, dumpFormat: string) => {
  const runToken = normalizeRunToken(runId)
  const artifactRoot = `${outputRoot.replace(/\/+$/, '')}/${runToken}`
  const dumpSuffix = dumpFormat === 'jsonl.gz' ? '.jsonl.gz' : dumpFormat === 'jsonl.zst' ? '.jsonl.zst' : '.ndjson'

  return DEFAULT_EXPECTED_ARTIFACTS.map((name) => {
    if (name === 'source-dump') {
      return {
        name: `source-dump${dumpSuffix}`,
        path: `${artifactRoot}/source-dump${dumpSuffix}`,
      }
    }
    return {
      name,
      path: `${artifactRoot}/${name}`,
    }
  })
}

const workflowPhaseToStatus = (phase: string | null) => {
  if (!phase) return 'submitted'
  const normalized = phase.trim().toLowerCase()
  if (normalized === 'running') return 'running'
  if (normalized === 'pending') return 'pending'
  if (normalized === 'succeeded') return 'succeeded'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  return normalized
}

const ensureDb = async () => {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is required for the Torghut simulation control plane')
  await ensureMigrations(db)
  return db
}

const buildWorkflowManifest = (params: {
  runId: string
  manifest: JsonRecord
  workflowNamespace: string
  forceReplay: boolean
  forceDump: boolean
  allowMissingState: boolean
  outputRoot: string
}) => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Workflow',
  metadata: {
    generateName: 'torghut-historical-simulation-',
    namespace: params.workflowNamespace,
    labels: {
      'jangar.proompteng.ai/control-plane': 'torghut-simulation',
      'jangar.proompteng.ai/run-id': params.runId,
    },
  },
  spec: {
    workflowTemplateRef: {
      name: DEFAULT_WORKFLOW_TEMPLATE_NAME,
    },
    arguments: {
      parameters: [
        { name: 'runId', value: params.runId },
        { name: 'mode', value: 'run' },
        {
          name: 'datasetManifestB64',
          value: Buffer.from(JSON.stringify(params.manifest), 'utf8').toString('base64'),
        },
        { name: 'confirmPhrase', value: DEFAULT_CONFIRM_PHRASE },
        { name: 'forceReplay', value: params.forceReplay ? 'true' : 'false' },
        { name: 'forceDump', value: params.forceDump ? 'true' : 'false' },
        { name: 'allowMissingState', value: params.allowMissingState ? 'true' : 'false' },
        { name: 'outputRoot', value: params.outputRoot },
      ],
    },
  },
})

const appendRunEvent = async (runId: string, eventType: string, payload: JsonRecord) => {
  const db = await ensureDb()
  const existing = await db
    .selectFrom('torghut_control_plane.simulation_run_events')
    .select(({ fn }) => fn.max<number>('seq').as('seq'))
    .where('run_id', '=', runId)
    .executeTakeFirst()
  const nextSeq = (existing?.seq ?? 0) + 1
  await db
    .insertInto('torghut_control_plane.simulation_run_events')
    .values({
      run_id: runId,
      seq: nextSeq,
      event_type: eventType,
      payload,
    })
    .execute()
}

const upsertExpectedArtifacts = async (runId: string, outputRoot: string, dumpFormat: string) => {
  const db = await ensureDb()
  for (const artifact of expectedArtifactsForRun(runId, outputRoot, dumpFormat)) {
    await db
      .insertInto('torghut_control_plane.simulation_artifacts')
      .values({
        run_id: runId,
        name: artifact.name,
        path: artifact.path,
        kind: 'expected',
        metadata: {},
      })
      .onConflict((oc) =>
        oc.columns(['run_id', 'name']).doUpdateSet({
          path: artifact.path,
          kind: 'expected',
          metadata: {},
          updated_at: new Date(),
        }),
      )
      .execute()
  }
}

export const parseTorghutSimulationRunRequest = (
  payload: unknown,
): { ok: true; value: TorghutSimulationRunRequest } | { ok: false; message: string } => {
  const body = asRecord(payload)
  const manifest = asRecord(body.manifest)
  if (Object.keys(manifest).length === 0) {
    return { ok: false, message: 'manifest object is required' }
  }
  return {
    ok: true,
    value: {
      runId: asString(body.runId) ?? undefined,
      manifest,
      forceReplay: asBoolean(body.forceReplay),
      forceDump: asBoolean(body.forceDump),
      allowMissingState: asBoolean(body.allowMissingState),
      outputRoot: asString(body.outputRoot) ?? undefined,
      priority: asString(body.priority) ?? undefined,
      cachePolicy: asString(body.cachePolicy) ?? undefined,
      profile: asString(body.profile) ?? undefined,
      submittedBy: asString(body.submittedBy),
      metadata: asRecord(body.metadata),
    },
  }
}

export const parseTorghutSimulationCampaignRequest = (
  payload: unknown,
): { ok: true; value: TorghutSimulationCampaignRequest } | { ok: false; message: string } => {
  const body = asRecord(payload)
  const manifest = asRecord(body.manifest)
  if (Object.keys(manifest).length === 0) {
    return { ok: false, message: 'manifest object is required' }
  }

  const windows = asArray(body.windows).flatMap((item) => {
    const record = asRecord(item)
    const start = asString(record.start)
    const end = asString(record.end)
    if (!start || !end) return []
    return [
      {
        start,
        end,
        label: asString(record.label) ?? undefined,
      },
    ]
  })

  if (windows.length === 0) {
    return { ok: false, message: 'windows must contain at least one { start, end } entry' }
  }

  const candidateRefs = asArray(body.candidateRefs)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item))

  return {
    ok: true,
    value: {
      campaignId: asString(body.campaignId) ?? undefined,
      name: asString(body.name) ?? undefined,
      manifest,
      windows,
      candidateRef: asString(body.candidateRef),
      candidateRefs,
      baselineCandidateRef: asString(body.baselineCandidateRef),
      strategyRef: asString(body.strategyRef),
      windowSetRef: asString(body.windowSetRef),
      simulationProfile: asString(body.simulationProfile),
      costModelVersion: asString(body.costModelVersion),
      artifactRoot: asString(body.artifactRoot),
      gateConfigRef: asString(body.gateConfigRef),
      campaignMode: asString(body.campaignMode),
      stressProfile: asRecord(body.stressProfile),
      priority: asString(body.priority) ?? undefined,
      cachePolicy: asString(body.cachePolicy) ?? undefined,
      profile: asString(body.profile) ?? undefined,
      submittedBy: asString(body.submittedBy),
    },
  }
}

export const submitTorghutSimulationRun = async (request: TorghutSimulationRunRequest) => {
  const db = await ensureDb()
  const kube = createKubernetesClient()
  const runId =
    request.runId ?? `sim-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}-${randomUUID().slice(0, 8)}`
  const manifest = normalizeSimulationManifest(request.manifest, {
    runId,
    outputRoot: request.outputRoot,
    cachePolicy: request.cachePolicy,
    profile: request.profile,
  })
  const performance = asRecord(manifest.performance)
  const lane = asString(manifest.lane) ?? 'equity'
  const profile = asString(performance.replayProfile) ?? DEFAULT_PROFILE
  const runClass = resolveRunClass(profile, request.priority ?? DEFAULT_PRIORITY)
  const cacheKey = buildSimulationCacheKey(manifest, profile)
  const digest = manifestDigest(manifest)
  const idempotencyKey = `${runId}:${digest}:${request.forceReplay ? 'replay' : 'noreplay'}:${request.forceDump ? 'dump' : 'nodump'}`
  const requestedCachePolicy = (request.cachePolicy ?? DEFAULT_CACHE_POLICY).trim().toLowerCase()

  const existing = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst()
  if (existing) {
    return {
      idempotent: true,
      run: snapshotFromRow(existing as unknown as Record<string, unknown>),
    }
  }

  const runtime = asRecord(manifest.runtime)
  const outputRoot = String(runtime.output_root ?? DEFAULT_OUTPUT_ROOT)
  const workflowOutputRoot = resolveWorkflowOutputRoot(outputRoot)
  const artifactRoot = `${outputRoot.replace(/\/+$/, '')}/${normalizeRunToken(runId)}`
  const cachedDataset =
    requestedCachePolicy === 'refresh'
      ? null
      : await db
          .selectFrom('torghut_control_plane.dataset_cache')
          .selectAll()
          .where('cache_key', '=', cacheKey)
          .where('status', '=', 'ready')
          .executeTakeFirst()
  const cacheDecision = cachedDataset ? 'hit' : requestedCachePolicy === 'refresh' ? 'refresh' : 'miss'
  const cacheStatus = cachedDataset ? 'hit' : 'miss'
  const cachePaths = buildDatasetCacheArtifactPaths(cacheKey, asString(performance.dumpFormat) ?? DEFAULT_DUMP_FORMAT)
  const cacheArtifactPath = asString(cachedDataset?.artifact_path) ?? cachePaths.artifactPath
  const cacheChunkManifestPath = asString(cachedDataset?.chunk_manifest_path) ?? cachePaths.chunkManifestPath
  const cacheBuiltByRunId = asString(cachedDataset?.built_by_run_id) ?? (cachedDataset ? undefined : runId)
  if (requestedCachePolicy === 'require_cache' && !cachedDataset) {
    throw new Error(`required simulation dataset cache is missing for cache_key=${cacheKey}`)
  }

  const manifestMetadata = asRecord(manifest.metadata)
  manifest.metadata = {
    ...manifestMetadata,
    cacheKey,
    cacheDecision,
    cacheArtifactPath,
    cacheChunkManifestPath,
    cacheBuiltByRunId,
  }

  await db
    .insertInto('torghut_control_plane.simulation_runs')
    .values({
      run_id: runId,
      idempotency_key: idempotencyKey,
      workflow_name: null,
      workflow_uid: null,
      namespace: resolveSimulationWorkflowNamespace(manifest),
      status: 'submitting',
      workflow_phase: null,
      lane,
      lane_id: null,
      profile,
      cache_policy: asString(manifest.cachePolicy) ?? DEFAULT_CACHE_POLICY,
      cache_key: cacheKey,
      cache_status: cacheStatus,
      priority: request.priority ?? DEFAULT_PRIORITY,
      run_class: runClass,
      candidate_ref: asString(manifest.candidate_id),
      strategy_ref: asString(manifest.strategy_spec_ref),
      dataset_id: asString(manifest.dataset_id),
      artifact_root: artifactRoot,
      output_root: outputRoot,
      manifest,
      manifest_digest: digest,
      metadata: {
        ...request.metadata,
        cacheDecision,
        cacheArtifactPath,
        cacheChunkManifestPath,
        cacheBuiltByRunId,
        torghutService: resolveSimulationServiceName(manifest),
        torghutNamespace: resolveSimulationNamespace(manifest),
        workflowNamespace: resolveSimulationWorkflowNamespace(manifest),
        workflowOutputRoot,
      },
      progress: {
        phase: 'submitting',
      },
      final_verdict: {},
      submitted_by: request.submittedBy ?? null,
      started_at: null,
      finished_at: null,
    })
    .execute()

  let laneReservation: { laneId: string; leaseExpiresAt: Date }
  try {
    laneReservation = await reserveSimulationLane({
      runId,
      runClass,
      cacheKey,
    })
  } catch (error) {
    await db.deleteFrom('torghut_control_plane.simulation_runs').where('run_id', '=', runId).execute()
    throw error
  }

  await db
    .updateTable('torghut_control_plane.simulation_runs')
    .set({
      lane_id: laneReservation.laneId,
      metadata: {
        ...request.metadata,
        cacheDecision,
        cacheArtifactPath,
        cacheChunkManifestPath,
        cacheBuiltByRunId,
        laneReservation: {
          laneId: laneReservation.laneId,
          leaseExpiresAt: laneReservation.leaseExpiresAt.toISOString(),
        },
        torghutService: resolveSimulationServiceName(manifest),
        torghutNamespace: resolveSimulationNamespace(manifest),
        workflowNamespace: resolveSimulationWorkflowNamespace(manifest),
        workflowOutputRoot,
      },
      progress: {
        phase: 'lane_reserved',
      },
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  const workflowManifest = buildWorkflowManifest({
    runId,
    manifest,
    workflowNamespace: resolveSimulationWorkflowNamespace(manifest),
    forceReplay: request.forceReplay ?? false,
    forceDump: request.forceDump ?? false,
    allowMissingState: request.allowMissingState ?? false,
    outputRoot: workflowOutputRoot,
  })
  let created: Record<string, unknown>
  try {
    created = await kube.apply(workflowManifest as Record<string, unknown>)
  } catch (error) {
    await releaseSimulationLane(runId)
    await db.deleteFrom('torghut_control_plane.simulation_runs').where('run_id', '=', runId).execute()
    throw error
  }
  const metadata = asRecord(created.metadata)
  const status = asRecord(created.status)
  const workflowName = asString(metadata.name)
  const workflowUid = asString(metadata.uid)
  const workflowPhase = asString(status.phase)

  await db
    .updateTable('torghut_control_plane.simulation_runs')
    .set({
      workflow_name: workflowName,
      workflow_uid: workflowUid,
      status: workflowPhaseToStatus(workflowPhase),
      workflow_phase: workflowPhase,
      metadata: {
        ...request.metadata,
        cacheDecision,
        cacheArtifactPath,
        cacheChunkManifestPath,
        cacheBuiltByRunId,
        laneReservation: {
          laneId: laneReservation.laneId,
          leaseExpiresAt: laneReservation.leaseExpiresAt.toISOString(),
        },
        torghutService: resolveSimulationServiceName(manifest),
        torghutNamespace: resolveSimulationNamespace(manifest),
        workflowNamespace: resolveSimulationWorkflowNamespace(manifest),
        workflowOutputRoot,
        workflowResource: created,
      },
      progress: {
        phase: workflowPhase,
      },
      started_at: asString(status.startedAt) ? new Date(String(status.startedAt)) : null,
      finished_at: asString(status.finishedAt) ? new Date(String(status.finishedAt)) : null,
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  await appendRunEvent(runId, 'simulation_run.submitted', {
    workflowName,
    workflowUid,
    workflowPhase,
    laneId: laneReservation.laneId,
    cacheStatus,
    cacheKey,
  })
  if (cachedDataset) {
    await touchDatasetCacheHit(cacheKey)
  } else {
    await upsertDatasetCache({
      cacheKey,
      lane,
      manifest,
      profile,
      runId,
      status: 'building',
    })
  }
  await upsertExpectedArtifacts(runId, outputRoot, asString(performance.dumpFormat) ?? DEFAULT_DUMP_FORMAT)

  const createdRow = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()

  return {
    idempotent: false,
    run: snapshotFromRow(createdRow as unknown as Record<string, unknown>),
  }
}

export const getTorghutSimulationRun = async (runId: string) => {
  const db = await ensureDb()
  const row = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst()
  if (!row) return null
  return snapshotFromRow(row as unknown as Record<string, unknown>)
}

export const listTorghutSimulationRuns = async (limit = 20) => {
  const db = await ensureDb()
  await reconcileSimulationLaneLeases(db)
  const rows = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((row) => snapshotFromRow(row as unknown as Record<string, unknown>))
}

export const listTorghutSimulationArtifacts = async (runId: string): Promise<TorghutSimulationArtifactRecord[]> => {
  const db = await ensureDb()
  const rows = await db
    .selectFrom('torghut_control_plane.simulation_artifacts')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('name', 'asc')
    .execute()
  return rows.map((row) => ({
    name: row.name,
    path: row.path,
    kind: row.kind,
    metadata: asRecord(row.metadata),
    updatedAt: String(row.updated_at),
  }))
}

export const listTorghutSimulationPresets = async (): Promise<TorghutSimulationPreset[]> =>
  DEFAULT_SIMULATION_PRESETS.map((preset) => structuredClone(preset))

export const submitTorghutSimulationCampaign = async (request: TorghutSimulationCampaignRequest) => {
  const db = await ensureDb()
  const normalized = normalizeCampaignRequest(request)
  const campaignId = normalizeRunToken(normalized.campaignId)
  const outputRoot = normalized.artifactRoot ?? `${DEFAULT_CAMPAIGN_OUTPUT_ROOT}/${campaignId}`

  await db
    .insertInto('torghut_control_plane.simulation_campaigns')
    .values({
      campaign_id: campaignId,
      name: normalized.name,
      status: 'submitted',
      request_payload: normalized,
      summary: {
        totalRuns: 0,
        runIds: [],
        candidateRef: normalized.candidateRef,
        candidateRefs: normalized.candidateRefs,
        strategyRef: normalized.strategyRef,
        windowSetRef: normalized.windowSetRef,
        simulationProfile: normalized.simulationProfile,
        costModelVersion: normalized.costModelVersion,
        artifactRoot: outputRoot,
        gateConfigRef: normalized.gateConfigRef,
        campaignMode: normalized.campaignMode,
      },
    })
    .onConflict((oc) =>
      oc.column('campaign_id').doUpdateSet({
        name: normalized.name,
        status: 'submitted',
        request_payload: normalized,
        updated_at: new Date(),
      }),
    )
    .execute()

  const runs: TorghutSimulationRunSnapshot[] = []
  for (const candidateRef of normalized.candidateRefs) {
    for (const windowSpec of normalized.windows) {
      const manifest = structuredClone(normalized.manifest)
      manifest.window = {
        start: windowSpec.start,
        end: windowSpec.end,
      }
      manifest.candidate_id = candidateRef
      if (normalized.baselineCandidateRef) manifest.baseline_candidate_id = normalized.baselineCandidateRef
      if (normalized.strategyRef) manifest.strategy_spec_ref = normalized.strategyRef
      if (normalized.costModelVersion) manifest.cost_model_version = normalized.costModelVersion
      const label = asString(windowSpec.label)
      if (label) manifest.window_label = label
      manifest.campaign = {
        ...(asRecord(manifest.campaign) ?? {}),
        campaignId,
        windowSetRef: normalized.windowSetRef,
        gateConfigRef: normalized.gateConfigRef,
        campaignMode: normalized.campaignMode,
        stressProfile: normalized.stressProfile,
      }

      const result = await submitTorghutSimulationRun({
        runId: buildCampaignRunId(campaignId, candidateRef, windowSpec),
        manifest,
        outputRoot,
        cachePolicy: normalized.cachePolicy,
        profile: normalized.profile,
        priority: normalized.priority,
        submittedBy: normalized.submittedBy,
        metadata: {
          campaignId,
          candidateRef,
          window: windowSpec,
          campaignName: normalized.name,
          strategyRef: normalized.strategyRef,
          simulationProfile: normalized.simulationProfile,
          costModelVersion: normalized.costModelVersion,
          gateConfigRef: normalized.gateConfigRef,
          campaignMode: normalized.campaignMode,
        },
      })
      runs.push(result.run)
      await db
        .insertInto('torghut_control_plane.simulation_campaign_runs')
        .values({
          campaign_id: campaignId,
          run_id: result.run.runId,
          candidate_ref: candidateRef,
          window_label: asString(windowSpec.label),
        })
        .onConflict((oc) => oc.columns(['campaign_id', 'run_id']).doNothing())
        .execute()
    }
  }

  const summary = campaignSummaryFromRuns(normalized, runs)
  await db
    .updateTable('torghut_control_plane.simulation_campaigns')
    .set({
      status: runs.some((run) => run.status === 'failed') ? 'degraded' : 'running',
      summary,
      updated_at: new Date(),
    })
    .where('campaign_id', '=', campaignId)
    .execute()

  const row = await db
    .selectFrom('torghut_control_plane.simulation_campaigns')
    .selectAll()
    .where('campaign_id', '=', campaignId)
    .executeTakeFirstOrThrow()
  return {
    campaign: campaignSnapshotFromRow(row as unknown as Record<string, unknown>),
    runs,
  }
}

export const getTorghutSimulationCampaign = async (campaignId: string) => {
  const db = await ensureDb()
  const row = await db
    .selectFrom('torghut_control_plane.simulation_campaigns')
    .selectAll()
    .where('campaign_id', '=', campaignId)
    .executeTakeFirst()
  if (!row) return null

  const campaignRunRows = await db
    .selectFrom('torghut_control_plane.simulation_campaign_runs')
    .select(['run_id'])
    .where('campaign_id', '=', campaignId)
    .orderBy('created_at', 'asc')
    .execute()
  const requestPayload = asRecord(row.request_payload)
  const summary = asRecord(row.summary)
  const runIds =
    campaignRunRows.length > 0
      ? campaignRunRows.map((item) => item.run_id)
      : asArray(summary.runIds)
          .map((item) => asString(item))
          .filter((item): item is string => Boolean(item))
  const runs: TorghutSimulationRunSnapshot[] = []
  for (const runId of runIds) {
    const run = await syncTorghutSimulationRun(runId)
    if (run) runs.push(run)
  }
  const request = {
    campaignId: String(row.campaign_id),
    name: String(row.name),
    manifest: asRecord(requestPayload.manifest),
    windows: asArray(requestPayload.windows)
      .map((item) => asRecord(item))
      .map((item) => ({
        start: String(item.start ?? ''),
        end: String(item.end ?? ''),
        label: asString(item.label),
      })),
    candidateRefs: asArray(requestPayload.candidateRefs)
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item)),
    candidateRef: asString(requestPayload.candidateRef),
    baselineCandidateRef: asString(requestPayload.baselineCandidateRef),
    strategyRef: asString(requestPayload.strategyRef),
    windowSetRef: asString(requestPayload.windowSetRef),
    simulationProfile: asString(requestPayload.simulationProfile),
    costModelVersion: asString(requestPayload.costModelVersion),
    artifactRoot: asString(requestPayload.artifactRoot),
    gateConfigRef: asString(requestPayload.gateConfigRef),
    campaignMode: asString(requestPayload.campaignMode),
    stressProfile: asRecord(requestPayload.stressProfile),
    priority: asString(requestPayload.priority) ?? undefined,
    cachePolicy: asString(requestPayload.cachePolicy) ?? undefined,
    profile: asString(requestPayload.profile) ?? undefined,
    submittedBy: asString(requestPayload.submittedBy),
  } satisfies TorghutSimulationCampaignRequest
  const nextSummary = campaignSummaryFromRuns(request, runs)
  const status = runs.every((run) => run.status === 'succeeded')
    ? 'succeeded'
    : runs.some((run) => run.status === 'failed')
      ? 'failed'
      : runs.some((run) => run.status === 'running' || run.status === 'pending' || run.status === 'submitted')
        ? 'running'
        : String(row.status)

  await db
    .updateTable('torghut_control_plane.simulation_campaigns')
    .set({
      status,
      summary: nextSummary,
      updated_at: new Date(),
    })
    .where('campaign_id', '=', campaignId)
    .execute()

  const updated = await db
    .selectFrom('torghut_control_plane.simulation_campaigns')
    .selectAll()
    .where('campaign_id', '=', campaignId)
    .executeTakeFirstOrThrow()
  return {
    campaign: campaignSnapshotFromRow(updated as unknown as Record<string, unknown>),
    runs,
  }
}

export const listTorghutSimulationCampaigns = async (limit = 20) => {
  const db = await ensureDb()
  const rows = await db
    .selectFrom('torghut_control_plane.simulation_campaigns')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((row) => campaignSnapshotFromRow(row as unknown as Record<string, unknown>))
}

export const syncTorghutSimulationRun = async (runId: string) => {
  const db = await ensureDb()
  const row = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst()
  if (!row) return null
  if (!row.workflow_name) return snapshotFromRow(row as unknown as Record<string, unknown>)

  const kube = createKubernetesClient()
  const workflow = await kube.get('workflows.argoproj.io', row.workflow_name, row.namespace)
  if (!workflow) {
    return snapshotFromRow(row as unknown as Record<string, unknown>)
  }

  const workflowStatus = asRecord(workflow.status)
  const workflowPhase = asString(workflowStatus.phase)
  const nextStatus = workflowPhaseToStatus(workflowPhase)
  const metadata = {
    ...asRecord(row.metadata),
    workflowResource: workflow,
  }
  const startedAt = asString(workflowStatus.startedAt)
  const finishedAt = asString(workflowStatus.finishedAt)
  const changed = nextStatus !== row.status || workflowPhase !== row.workflow_phase

  await db
    .updateTable('torghut_control_plane.simulation_runs')
    .set({
      workflow_phase: workflowPhase,
      status: nextStatus,
      metadata,
      started_at: startedAt ? new Date(startedAt) : row.started_at,
      finished_at: finishedAt ? new Date(finishedAt) : row.finished_at,
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  if (changed) {
    await appendRunEvent(runId, 'simulation_run.workflow_phase_changed', {
      workflowPhase,
      status: nextStatus,
    })
  }

  let updated = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  let snapshot = snapshotFromRow(updated as unknown as Record<string, unknown>)
  const progress = (await fetchSimulationProgress(snapshot)) ?? snapshot.progress
  const finalVerdict = TERMINAL_RUN_STATUSES.has(snapshot.status)
    ? deriveFinalVerdict(snapshot, progress)
    : snapshot.finalVerdict

  await db
    .updateTable('torghut_control_plane.simulation_runs')
    .set({
      progress,
      final_verdict: finalVerdict,
      cache_status: TERMINAL_RUN_STATUSES.has(snapshot.status)
        ? snapshot.status === 'succeeded'
          ? asString(asRecord(snapshot.metadata).cacheDecision) === 'hit'
            ? 'hit'
            : 'ready'
          : 'failed'
        : snapshot.cacheStatus,
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
    await releaseSimulationLane(runId)
    const cacheDecision = asString(asRecord(snapshot.metadata).cacheDecision) ?? 'miss'
    if (cacheDecision !== 'hit') {
      await upsertDatasetCache({
        cacheKey: snapshot.cacheKey ?? buildSimulationCacheKey(snapshot.manifest, snapshot.profile),
        lane: snapshot.lane,
        manifest: snapshot.manifest,
        profile: snapshot.profile,
        runId: snapshot.runId,
        status: snapshot.status === 'succeeded' ? 'ready' : 'failed',
      })
    }
    await appendRunEvent(runId, 'simulation_run.completed', {
      status: snapshot.status,
      finalVerdict,
    })
  }

  updated = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  snapshot = snapshotFromRow(updated as unknown as Record<string, unknown>)
  return snapshot
}

export const cancelTorghutSimulationRun = async (runId: string) => {
  const db = await ensureDb()
  const row = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirst()
  if (!row) return null

  if (row.workflow_name) {
    const kube = createKubernetesClient()
    await kube.delete('workflows.argoproj.io', row.workflow_name, row.namespace, { wait: false, timeoutSeconds: 5 })
  }

  await db
    .updateTable('torghut_control_plane.simulation_runs')
    .set({
      status: 'cancelled',
      workflow_phase: 'Cancelled',
      cache_status: 'failed',
      final_verdict: {
        authoritative: true,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      },
      finished_at: new Date(),
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  await appendRunEvent(runId, 'simulation_run.cancelled', {})
  await releaseSimulationLane(runId)
  return getTorghutSimulationRun(runId)
}

export const __private = {
  buildRobustnessScorecard,
  buildSimulationCacheKey,
  expectedArtifactsForRun,
  buildCampaignRunId,
  manifestDigest,
  normalizeCampaignRequest,
  normalizeRunToken,
  normalizeSimulationManifest,
  resolveWorkflowOutputRoot,
}
