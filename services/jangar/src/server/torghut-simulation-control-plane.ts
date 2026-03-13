import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'
import { createKubernetesClient } from '~/server/primitives-kube'

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
  candidateRefs?: string[]
  baselineCandidateRef?: string | null
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
  profile: string
  cachePolicy: string
  priority: string
  candidateRef: string | null
  strategyRef: string | null
  datasetId: string | null
  artifactRoot: string | null
  outputRoot: string | null
  manifest: JsonRecord
  metadata: JsonRecord
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

const DEFAULT_NAMESPACE = 'torghut'
const DEFAULT_OUTPUT_ROOT = 'artifacts/torghut/simulations'
const DEFAULT_PRIORITY = 'interactive'
const DEFAULT_PROFILE = 'smoke'
const DEFAULT_CACHE_POLICY = 'prefer_cache'
const DEFAULT_CONFIRM_PHRASE = 'START_HISTORICAL_SIMULATION'
const DEFAULT_WORKFLOW_TEMPLATE_NAME = 'torghut-historical-simulation'
const DEFAULT_DUMP_FORMAT = 'jsonl.zst'
const DEFAULT_CAMPAIGN_OUTPUT_ROOT = `${DEFAULT_OUTPUT_ROOT}/campaigns`
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

const parseTimestamp = (value: unknown) => {
  const text = asString(value)
  if (!text) return null
  return text
}

const normalizeSimulationManifest = (
  manifestInput: JsonRecord,
  overrides: Pick<TorghutSimulationRunRequest, 'outputRoot' | 'cachePolicy' | 'profile'>,
) => {
  const manifest = structuredClone(manifestInput)
  const window = asRecord(manifest.window)
  if (!asString(manifest.dataset_id)) throw new Error('manifest.dataset_id is required')
  if (!asString(window.start)) throw new Error('manifest.window.start is required')
  if (!asString(window.end)) throw new Error('manifest.window.end is required')

  const runtime = asRecord(manifest.runtime)
  if (overrides.outputRoot) runtime.output_root = overrides.outputRoot
  if (!asString(runtime.output_root)) runtime.output_root = DEFAULT_OUTPUT_ROOT
  manifest.runtime = runtime

  const performance = asRecord(manifest.performance)
  if (overrides.profile) performance.replayProfile = overrides.profile
  if (!asString(performance.replayProfile)) performance.replayProfile = DEFAULT_PROFILE
  if (!asString(performance.dumpFormat)) performance.dumpFormat = DEFAULT_DUMP_FORMAT
  manifest.performance = performance

  if (overrides.cachePolicy) {
    manifest.cachePolicy = overrides.cachePolicy
  } else if (!asString(manifest.cachePolicy)) {
    manifest.cachePolicy = DEFAULT_CACHE_POLICY
  }

  return manifest
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
    candidateRefs: request.candidateRefs ?? [],
    windows: request.windows,
    baselineCandidateRef: request.baselineCandidateRef ?? null,
    statusOverride: statusOverride ?? null,
  }
}

const normalizeCampaignRequest = (request: TorghutSimulationCampaignRequest) => {
  const manifest = structuredClone(request.manifest)
  const candidateRefs =
    request.candidateRefs && request.candidateRefs.length > 0
      ? request.candidateRefs
      : [asString(manifest.candidate_id) ?? 'intraday_tsmom_v1@candidate']
  return {
    campaignId: request.campaignId ?? `campaign-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`,
    name: request.name ?? 'Torghut Simulation Campaign',
    manifest,
    windows: request.windows,
    candidateRefs,
    baselineCandidateRef: request.baselineCandidateRef ?? asString(manifest.baseline_candidate_id),
    priority: request.priority ?? DEFAULT_PRIORITY,
    cachePolicy: request.cachePolicy ?? DEFAULT_CACHE_POLICY,
    profile: request.profile ?? DEFAULT_PROFILE,
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
  profile: String(row.profile),
  cachePolicy: String(row.cache_policy),
  priority: String(row.priority),
  candidateRef: asString(row.candidate_ref),
  strategyRef: asString(row.strategy_ref),
  datasetId: asString(row.dataset_id),
  artifactRoot: asString(row.artifact_root),
  outputRoot: asString(row.output_root),
  manifest: asRecord(row.manifest),
  metadata: asRecord(row.metadata),
  submittedBy: asString(row.submitted_by),
  startedAt: parseTimestamp(row.started_at),
  finishedAt: parseTimestamp(row.finished_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

const manifestDigest = (manifest: JsonRecord) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

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
  forceReplay: boolean
  forceDump: boolean
  allowMissingState: boolean
  outputRoot: string
}) => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Workflow',
  metadata: {
    generateName: 'torghut-historical-simulation-',
    namespace: DEFAULT_NAMESPACE,
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
      candidateRefs,
      baselineCandidateRef: asString(body.baselineCandidateRef),
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
    outputRoot: request.outputRoot,
    cachePolicy: request.cachePolicy,
    profile: request.profile,
  })
  const digest = manifestDigest(manifest)
  const idempotencyKey = `${runId}:${digest}:${request.forceReplay ? 'replay' : 'noreplay'}:${request.forceDump ? 'dump' : 'nodump'}`

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
  const performance = asRecord(manifest.performance)
  const outputRoot = String(runtime.output_root ?? DEFAULT_OUTPUT_ROOT)
  const artifactRoot = `${outputRoot.replace(/\/+$/, '')}/${normalizeRunToken(runId)}`
  const workflowManifest = buildWorkflowManifest({
    runId,
    manifest,
    forceReplay: request.forceReplay ?? false,
    forceDump: request.forceDump ?? false,
    allowMissingState: request.allowMissingState ?? false,
    outputRoot,
  })
  const created = await kube.apply(workflowManifest as Record<string, unknown>)
  const metadata = asRecord(created.metadata)
  const status = asRecord(created.status)
  const workflowName = asString(metadata.name)
  const workflowUid = asString(metadata.uid)
  const workflowPhase = asString(status.phase)

  await db
    .insertInto('torghut_control_plane.simulation_runs')
    .values({
      run_id: runId,
      idempotency_key: idempotencyKey,
      workflow_name: workflowName,
      workflow_uid: workflowUid,
      namespace: DEFAULT_NAMESPACE,
      status: workflowPhaseToStatus(workflowPhase),
      workflow_phase: workflowPhase,
      lane: asString(manifest.lane) ?? 'equity',
      profile: asString(performance.replayProfile) ?? DEFAULT_PROFILE,
      cache_policy: asString(manifest.cachePolicy) ?? DEFAULT_CACHE_POLICY,
      priority: request.priority ?? DEFAULT_PRIORITY,
      candidate_ref: asString(manifest.candidate_id),
      strategy_ref: asString(manifest.strategy_spec_ref),
      dataset_id: asString(manifest.dataset_id),
      artifact_root: artifactRoot,
      output_root: outputRoot,
      manifest,
      manifest_digest: digest,
      metadata: {
        ...request.metadata,
        workflowResource: created,
      },
      submitted_by: request.submittedBy ?? null,
      started_at: asString(status.startedAt) ? new Date(String(status.startedAt)) : null,
      finished_at: asString(status.finishedAt) ? new Date(String(status.finishedAt)) : null,
    })
    .execute()

  await appendRunEvent(runId, 'simulation_run.submitted', {
    workflowName,
    workflowUid,
    workflowPhase,
  })
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
  const outputRoot = `${DEFAULT_CAMPAIGN_OUTPUT_ROOT}/${campaignId}`

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
      const label = asString(windowSpec.label)
      if (label) manifest.window_label = label

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
        },
      })
      runs.push(result.run)
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

  const requestPayload = asRecord(row.request_payload)
  const summary = asRecord(row.summary)
  const runIds = asArray(summary.runIds)
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
    baselineCandidateRef: asString(requestPayload.baselineCandidateRef),
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

  const updated = await db
    .selectFrom('torghut_control_plane.simulation_runs')
    .selectAll()
    .where('run_id', '=', runId)
    .executeTakeFirstOrThrow()
  return snapshotFromRow(updated as unknown as Record<string, unknown>)
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
      finished_at: new Date(),
      updated_at: new Date(),
    })
    .where('run_id', '=', runId)
    .execute()

  await appendRunEvent(runId, 'simulation_run.cancelled', {})
  return getTorghutSimulationRun(runId)
}

export const __private = {
  expectedArtifactsForRun,
  buildCampaignRunId,
  normalizeRunToken,
  normalizeSimulationManifest,
}
