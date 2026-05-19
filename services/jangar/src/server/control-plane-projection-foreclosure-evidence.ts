import type {
  SourceRolloutTruthExchange,
  StageClearancePacket,
  TorghutConsumerEvidenceStatus,
} from '~/data/agents-control-plane'
import { fetchAgentRunsFromAgentsService } from '~/server/agents-service-proxy'
import { getDb } from '~/server/db'
import type { KubeGateway, KubeGatewayAgentRun, KubeGatewayJob } from '~/server/kube-gateway'

export type JsonRecord = Record<string, unknown>

export type ProjectionForeclosureAgentRunProjection = {
  id: string
  agent_name: string
  delivery_id: string
  status: string
  external_run_id: string | null
  payload: JsonRecord
  created_at: string | null
  updated_at: string | null
}

export type ProjectionForeclosureMarketContextProjection = {
  request_id: string
  symbol: string
  domain: string
  run_name: string | null
  status: string
  started_at: string | null
  last_heartbeat_at: string | null
  finished_at: string | null
  created_at: string | null
  updated_at: string | null
}

export type ProjectionForeclosureEvidence = {
  agentRunProjections: ProjectionForeclosureAgentRunProjection[]
  marketContextProjections: ProjectionForeclosureMarketContextProjection[]
  liveAgentRuns: KubeGatewayAgentRun[]
  liveJobs: KubeGatewayJob[]
  collectionErrors: string[]
}

export type ProjectionForeclosureNotaryInput = ProjectionForeclosureEvidence & {
  now: Date
  namespace: string
  sourceHeadSha: string | null
  gitopsRevision: string | null
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  stageClearancePackets: StageClearancePacket[]
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

export const ACTIVE_PROJECTION_STATUSES = new Set([
  'pending',
  'queued',
  'started',
  'submitted',
  'running',
  'in_progress',
  'progress',
  'progressing',
])

const ACTIVE_PROJECTION_STATUS_QUERY_VALUES = [
  ...ACTIVE_PROJECTION_STATUSES,
  ...[...ACTIVE_PROJECTION_STATUSES].map((status) =>
    status.replace(/(^|_)([a-z])/g, (_, prefix, char: string) => `${prefix}${char.toUpperCase()}`),
  ),
  ...[...ACTIVE_PROJECTION_STATUSES].map((status) => status.toUpperCase()),
]

export const emptyProjectionForeclosureEvidence = (): ProjectionForeclosureEvidence => ({
  agentRunProjections: [],
  marketContextProjections: [],
  liveAgentRuns: [],
  liveJobs: [],
  collectionErrors: [],
})

export const isProjectionForeclosureNotaryEnabled = (env: NodeJS.ProcessEnv = process.env) => {
  const normalized = env.JANGAR_PROJECTION_FORECLOSURE_NOTARY_ENABLED?.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
}

export const isProjectionForeclosureConsumptionEnabled = (env: NodeJS.ProcessEnv = process.env) => {
  const normalized = env.JANGAR_PROJECTION_FORECLOSURE_CONSUME?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes'
}

export const collectProjectionForeclosureEvidence = async (input: {
  namespace: string
  kube: KubeGateway
}): Promise<ProjectionForeclosureEvidence> => {
  const evidence = emptyProjectionForeclosureEvidence()
  const db = getDb()

  const agentRunResult = await fetchAgentRunsFromAgentsService({
    statuses: ACTIVE_PROJECTION_STATUS_QUERY_VALUES,
    limit: 100,
  })
  if (agentRunResult.ok) {
    evidence.agentRunProjections = agentRunResult.body.runs
      .filter((row) => ACTIVE_PROJECTION_STATUSES.has(normalizeStatus(row.status)))
      .map((row) => ({
        id: row.id,
        agent_name: row.agentName,
        delivery_id: row.deliveryId,
        status: row.status,
        external_run_id: row.externalRunId,
        payload: asRecord(row.payload),
        created_at: toIso(row.createdAt),
        updated_at: toIso(row.updatedAt),
      }))
  } else {
    evidence.collectionErrors.push(
      `Agents service agent_runs projection collection failed: ${agentRunResult.error ?? `HTTP ${agentRunResult.status}`}`,
    )
  }

  if (db) {
    try {
      const rows = await db
        .selectFrom('torghut_market_context_runs')
        .select([
          'request_id',
          'symbol',
          'domain',
          'run_name',
          'status',
          'started_at',
          'last_heartbeat_at',
          'finished_at',
          'created_at',
          'updated_at',
        ])
        .where('status', 'in', ACTIVE_PROJECTION_STATUS_QUERY_VALUES)
        .orderBy('updated_at', 'desc')
        .limit(100)
        .execute()
      evidence.marketContextProjections = rows
        .filter((row) => ACTIVE_PROJECTION_STATUSES.has(normalizeStatus(row.status)))
        .map((row) => ({
          request_id: row.request_id,
          symbol: row.symbol,
          domain: row.domain,
          run_name: row.run_name,
          status: row.status,
          started_at: toIso(row.started_at),
          last_heartbeat_at: toIso(row.last_heartbeat_at),
          finished_at: toIso(row.finished_at),
          created_at: toIso(row.created_at),
          updated_at: toIso(row.updated_at),
        }))
    } catch (error) {
      evidence.collectionErrors.push(
        `torghut_market_context_runs projection collection failed: ${normalizeMessage(error)}`,
      )
    }
  }

  const [liveAgentRuns, liveJobs] = await Promise.all([
    collectItems(() => input.kube.listAgentRuns(input.namespace), 'AgentRun live authority'),
    collectItems(() => input.kube.listJobs(input.namespace), 'Job live authority'),
  ])

  evidence.liveAgentRuns = liveAgentRuns.items
  evidence.liveJobs = liveJobs.items
  evidence.collectionErrors.push(
    ...[liveAgentRuns.error, liveJobs.error].filter((error): error is string => Boolean(error)),
  )

  return evidence
}

const collectItems = async <T>(run: () => Promise<T[]>, label: string) => {
  try {
    return { items: await run(), error: null as string | null }
  } catch (error) {
    return { items: [] as T[], error: `${label} collection failed: ${normalizeMessage(error)}` }
  }
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const normalizeStatus = (value: string | null | undefined) =>
  (value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}

const toIso = (value: unknown): string | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
