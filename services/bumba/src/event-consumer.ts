import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import {
  createTemporalClient,
  type TemporalClient,
  type TemporalConfig,
  temporalCallOptions,
} from '@proompteng/temporal-bun-sdk'
import { VersioningBehavior } from '@proompteng/temporal-bun-sdk/worker'
import { SQL } from 'bun'

const DEFAULT_TASK_QUEUE = 'bumba'
const DEFAULT_REF = 'main'
const DEFAULT_POLL_INTERVAL_MS = 10_000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_EVENT_FILE_TARGETS = 200
const DEFAULT_MAX_DISPATCH_FAILURES = 6
const DEFAULT_NONTERMINAL_INGESTION_STALE_MS = 12 * 60 * 60 * 1000
const DEFAULT_ROUTING_ALIGNMENT_ENABLED = true
const DEFAULT_ROUTING_ALIGNMENT_RPC_TIMEOUT_MS = 5_000
const STALE_INGESTION_ERROR = 'stale nonterminal ingestion auto-failed by bumba event-consumer'

const LOCK_FILENAMES = new Set([
  'bun.lock',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'poetry.lock',
  'pipfile.lock',
  'yarn.lock',
  'npm-shrinkwrap.json',
])

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.db',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.ttf',
  '.wav',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.wasm',
  '.bin',
])

const TERMINAL_INGESTION_STATUSES = new Set(['completed', 'failed', 'skipped'])

type SqlClient = InstanceType<typeof SQL>

type GithubEventRow = {
  id: string
  delivery_id: string
  event_type: string
  repository: string
  payload: unknown
}

type IngestionCountsRow = {
  total: number | string | bigint
  terminal: number | string | bigint
  nonterminal: number | string | bigint
  oldest_nonterminal_started_at: Date | string | null
}

type GithubEventConsumerConfig = {
  enabled: boolean
  pollIntervalMs: number
  batchSize: number
  maxEventFileTargets: number
  maxDispatchFailures: number
  nonterminalIngestionStaleMs: number
  routingAlignmentEnabled: boolean
  taskQueue: string
  repoRoot: string
}

type IngestionCounts = {
  total: number
  terminal: number
  nonterminal: number
  oldestNonterminalStartedAt: number | null
}

type ProcessEventResult = {
  processed: boolean
  waitingOnIngestion: boolean
  dispatchStarted: number
  dispatchFailed: number
}

export type GithubEventConsumer = {
  start: () => Promise<void>
  stop: () => Promise<void>
  tick: () => Promise<void>
  isRunning: () => boolean
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

const resolveConsumerConfig = (): GithubEventConsumerConfig => ({
  enabled: parseBoolean(process.env.BUMBA_GITHUB_EVENT_CONSUMER_ENABLED, true),
  pollIntervalMs: parsePositiveInt(process.env.BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
  batchSize: parsePositiveInt(process.env.BUMBA_GITHUB_EVENT_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  maxEventFileTargets: parsePositiveInt(
    process.env.BUMBA_GITHUB_EVENT_MAX_FILE_TARGETS,
    DEFAULT_MAX_EVENT_FILE_TARGETS,
  ),
  maxDispatchFailures: parsePositiveInt(
    process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_FAILURES,
    DEFAULT_MAX_DISPATCH_FAILURES,
  ),
  nonterminalIngestionStaleMs: parsePositiveInt(
    process.env.BUMBA_GITHUB_EVENT_NONTERMINAL_STALE_MS,
    DEFAULT_NONTERMINAL_INGESTION_STALE_MS,
  ),
  routingAlignmentEnabled: parseBoolean(
    process.env.BUMBA_GITHUB_EVENT_ROUTING_ALIGNMENT_ENABLED,
    DEFAULT_ROUTING_ALIGNMENT_ENABLED,
  ),
  taskQueue: normalizeOptionalText(process.env.TEMPORAL_TASK_QUEUE) ?? DEFAULT_TASK_QUEUE,
  repoRoot: resolve(
    normalizeOptionalText(process.env.BUMBA_WORKSPACE_ROOT) ??
      normalizeOptionalText(process.env.CODEX_CWD) ??
      process.cwd(),
  ),
})

const withDefaultSslMode = (rawUrl: string) => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const params = url.searchParams
  if (params.get('sslmode')) return rawUrl

  const envMode = process.env.PGSSLMODE?.trim()
  const sslmode = envMode && envMode.length > 0 ? envMode : 'require'
  params.set('sslmode', sslmode)

  url.search = params.toString()
  return url.toString()
}

const shouldSkipFilePath = (filePath: string) => {
  const normalized = filePath.trim()
  if (normalized.length === 0) return true

  const lower = normalized.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  const extension = base.includes('.') ? `.${base.split('.').pop()}` : ''

  if (LOCK_FILENAMES.has(base)) return true
  if (extension === '.lock') return true
  if (BINARY_EXTENSIONS.has(extension)) return true

  return false
}

const normalizePathList = (value: unknown) => {
  if (!Array.isArray(value)) return [] as string[]

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const collectCommitPaths = (commitPayload: Record<string, unknown>) => {
  const paths = new Set<string>()

  for (const path of normalizePathList(commitPayload.added)) {
    if (!shouldSkipFilePath(path)) {
      paths.add(path)
    }
  }

  for (const path of normalizePathList(commitPayload.modified)) {
    if (!shouldSkipFilePath(path)) {
      paths.add(path)
    }
  }

  return paths
}

const extractEventFilePaths = (payload: Record<string, unknown>, maxTargets: number) => {
  const paths = new Set<string>()

  const headCommit = asRecord(payload.head_commit)
  if (headCommit) {
    for (const path of collectCommitPaths(headCommit)) {
      paths.add(path)
    }
  }

  const commits = Array.isArray(payload.commits) ? payload.commits : []
  for (const commit of commits) {
    const record = asRecord(commit)
    if (!record) continue
    for (const path of collectCommitPaths(record)) {
      paths.add(path)
    }
  }

  return Array.from(paths).sort().slice(0, maxTargets)
}

const resolveEventPayload = (rawPayload: unknown): Record<string, unknown> => {
  const record = asRecord(rawPayload)
  if (record) return record

  if (typeof rawPayload === 'string') {
    try {
      const parsed = JSON.parse(rawPayload) as unknown
      return asRecord(parsed) ?? {}
    } catch {
      return {}
    }
  }

  return {}
}

const resolveEventCommit = (payload: Record<string, unknown>) => {
  return (
    normalizeOptionalText(payload.after) ??
    normalizeOptionalText(asRecord(payload.head_commit)?.id) ??
    normalizeOptionalText(asRecord(asRecord(payload.pull_request)?.head)?.sha)
  )
}

const resolveEventRef = (payload: Record<string, unknown>) => {
  return (
    normalizeOptionalText(payload.ref) ??
    normalizeOptionalText(asRecord(payload.repository)?.default_branch) ??
    normalizeOptionalText(asRecord(asRecord(payload.pull_request)?.base)?.ref) ??
    DEFAULT_REF
  )
}

const toNumber = (value: number | string | bigint | null | undefined) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const toEpochMs = (value: Date | string | number | null | undefined) => {
  if (value instanceof Date) {
    const epoch = value.getTime()
    return Number.isFinite(epoch) ? epoch : null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const shortHash = (value: string) => createHash('sha1').update(value).digest('hex').slice(0, 12)

const buildEventWorkflowId = (deliveryId: string, filePath: string) => {
  const deliveryHash = shortHash(deliveryId)
  const pathHash = shortHash(filePath)
  return `bumba-event-${deliveryHash}-${pathHash}`
}

const resolveWorkerDeploymentName = (temporalConfig: TemporalConfig, taskQueue: string) => {
  return (
    normalizeOptionalText(process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME) ??
    normalizeOptionalText(temporalConfig.workerDeploymentName) ??
    `${taskQueue}-deployment`
  )
}

const extractCurrentDeploymentBuildId = (
  response: Awaited<ReturnType<TemporalClient['deployments']['describeWorkerDeployment']>>,
) => {
  return (
    normalizeOptionalText(response.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId) ??
    normalizeOptionalText(response.workerDeploymentInfo?.routingConfig?.currentVersion)
  )
}

const isTransientRoutingAlignmentError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('no pollers') ||
    normalized.includes('missing task queue') ||
    normalized.includes('missing task queues') ||
    normalized.includes('failed precondition') ||
    normalized.includes('not found')
  )
}

const isDeploymentApiUnavailableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('unimplemented') ||
    normalized.includes('unknown method') ||
    normalized.includes('unknown service') ||
    normalized.includes('method not found')
  )
}

const isWorkflowAlreadyStartedError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return (
    normalized.includes('workflowexecutionalreadystarted') ||
    normalized.includes('already started') ||
    normalized.includes('already running') ||
    normalized.includes('already_exists')
  )
}

const listPendingGithubEvents = async (db: SqlClient, limit: number): Promise<GithubEventRow[]> => {
  return (await db`
    SELECT id, delivery_id, event_type, repository, payload
    FROM atlas.github_events
    WHERE processed_at IS NULL
    ORDER BY received_at ASC
    LIMIT ${limit};
  `) as GithubEventRow[]
}

const getIngestionCounts = async (db: SqlClient, eventId: string): Promise<IngestionCounts> => {
  const rows = (await db`
    SELECT
      count(*)::bigint AS total,
      count(*) FILTER (WHERE status IN ('completed', 'failed', 'skipped'))::bigint AS terminal,
      count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'skipped'))::bigint AS nonterminal,
      min(started_at) FILTER (WHERE status NOT IN ('completed', 'failed', 'skipped')) AS oldest_nonterminal_started_at
    FROM atlas.ingestions
    WHERE event_id = ${eventId};
  `) as IngestionCountsRow[]

  const row = rows[0]
  if (!row) return { total: 0, terminal: 0, nonterminal: 0, oldestNonterminalStartedAt: null }

  return {
    total: toNumber(row.total),
    terminal: toNumber(row.terminal),
    nonterminal: toNumber(row.nonterminal),
    oldestNonterminalStartedAt: toEpochMs(row.oldest_nonterminal_started_at),
  }
}

const markStaleIngestionsFailed = async (db: SqlClient, eventId: string, staleMs: number) => {
  const rows = (await db`
    UPDATE atlas.ingestions
    SET
      status = 'failed',
      error = CASE
        WHEN error IS NULL OR error = '' THEN ${STALE_INGESTION_ERROR}
        WHEN error LIKE ${`${STALE_INGESTION_ERROR}%`} THEN error
        ELSE error || ${` | ${STALE_INGESTION_ERROR}`}
      END,
      finished_at = COALESCE(finished_at, now())
    WHERE event_id = ${eventId}
      AND status NOT IN ('completed', 'failed', 'skipped')
      AND started_at < now() - (${staleMs}::bigint * interval '1 millisecond')
    RETURNING id;
  `) as Array<{ id: string }>

  return rows.length
}

const markEventProcessed = async (db: SqlClient, deliveryId: string) => {
  await db`
    UPDATE atlas.github_events
    SET processed_at = now()
    WHERE delivery_id = ${deliveryId};
  `
}

const startEventWorkflow = async (
  client: TemporalClient,
  config: GithubEventConsumerConfig,
  event: GithubEventRow,
  filePath: string,
  ref: string,
  commit: string,
) => {
  const workflowId = buildEventWorkflowId(event.delivery_id, filePath)

  return await client.workflow.start({
    workflowId,
    workflowType: 'enrichFile',
    taskQueue: config.taskQueue,
    versioningBehavior: VersioningBehavior.AUTO_UPGRADE,
    args: [
      {
        repoRoot: config.repoRoot,
        filePath,
        repository: event.repository,
        ref,
        commit,
        eventDeliveryId: event.delivery_id,
      },
    ],
  })
}

const processEvent = async (
  db: SqlClient,
  client: TemporalClient,
  config: GithubEventConsumerConfig,
  event: GithubEventRow,
): Promise<ProcessEventResult> => {
  if (event.event_type !== 'push') {
    await markEventProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchFailed: 0,
    }
  }

  const payload = resolveEventPayload(event.payload)
  const commit = resolveEventCommit(payload)
  if (!commit) {
    console.warn('[bumba][event-consumer] skipping push event without commit', {
      deliveryId: event.delivery_id,
      repository: event.repository,
    })
    await markEventProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchFailed: 0,
    }
  }

  const files = extractEventFilePaths(payload, config.maxEventFileTargets)
  if (files.length === 0) {
    console.info('[bumba][event-consumer] skipping push event without indexable files', {
      deliveryId: event.delivery_id,
      repository: event.repository,
    })
    await markEventProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchFailed: 0,
    }
  }

  let ingestionCounts = await getIngestionCounts(db, event.id)
  if (ingestionCounts.total > 0) {
    if (ingestionCounts.total === ingestionCounts.terminal) {
      await markEventProcessed(db, event.delivery_id)
      return {
        processed: true,
        waitingOnIngestion: false,
        dispatchStarted: 0,
        dispatchFailed: 0,
      }
    }

    const oldestNonterminalStartedAt = ingestionCounts.oldestNonterminalStartedAt
    const isStaleBlocked =
      ingestionCounts.nonterminal > 0 &&
      oldestNonterminalStartedAt !== null &&
      Date.now() - oldestNonterminalStartedAt >= config.nonterminalIngestionStaleMs

    if (isStaleBlocked) {
      const staleFailed = await markStaleIngestionsFailed(db, event.id, config.nonterminalIngestionStaleMs)
      if (staleFailed > 0) {
        console.warn('[bumba][event-consumer] auto-failed stale nonterminal ingestions', {
          deliveryId: event.delivery_id,
          repository: event.repository,
          staleFailed,
          staleAfterMs: config.nonterminalIngestionStaleMs,
        })
        ingestionCounts = await getIngestionCounts(db, event.id)
        if (ingestionCounts.total === ingestionCounts.terminal) {
          await markEventProcessed(db, event.delivery_id)
          return {
            processed: true,
            waitingOnIngestion: false,
            dispatchStarted: 0,
            dispatchFailed: 0,
          }
        }
      }
    }

    return {
      processed: false,
      waitingOnIngestion: true,
      dispatchStarted: 0,
      dispatchFailed: 0,
    }
  }

  const ref = resolveEventRef(payload)

  let started = 0
  let failed = 0

  for (const filePath of files) {
    try {
      await startEventWorkflow(client, config, event, filePath, ref, commit)
      started += 1
    } catch (error) {
      if (isWorkflowAlreadyStartedError(error)) {
        started += 1
        continue
      }

      failed += 1
      console.warn('[bumba][event-consumer] failed to start enrichFile workflow', {
        deliveryId: event.delivery_id,
        repository: event.repository,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (started > 0) {
    console.info('[bumba][event-consumer] dispatched event workflows', {
      deliveryId: event.delivery_id,
      repository: event.repository,
      started,
      failed,
      files: files.length,
    })
    return {
      processed: false,
      waitingOnIngestion: false,
      dispatchStarted: started,
      dispatchFailed: failed,
    }
  }

  console.warn('[bumba][event-consumer] no workflows dispatched for event', {
    deliveryId: event.delivery_id,
    repository: event.repository,
    files: files.length,
  })

  return {
    processed: false,
    waitingOnIngestion: false,
    dispatchStarted: 0,
    dispatchFailed: failed,
  }
}

const createSqlClient = () => {
  const databaseUrl = normalizeOptionalText(process.env.DATABASE_URL)
  if (!databaseUrl) return null
  return new SQL(withDefaultSslMode(databaseUrl))
}

export const createGithubEventConsumer = (
  temporalConfig: TemporalConfig,
  configOverride?: Partial<GithubEventConsumerConfig>,
): GithubEventConsumer => {
  const config: GithubEventConsumerConfig = {
    ...resolveConsumerConfig(),
    ...(configOverride ?? {}),
  }

  let db: SqlClient | null = null
  let client: TemporalClient | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let tickPromise: Promise<void> = Promise.resolve()
  const inFlightDeliveries = new Set<string>()
  const dispatchFailureCounts = new Map<string, number>()
  const workerBuildId = normalizeOptionalText(temporalConfig.workerBuildId)
  const workerDeploymentName = resolveWorkerDeploymentName(temporalConfig, config.taskQueue)
  let routingAligned = !config.routingAlignmentEnabled || !workerBuildId
  let routingGuardFailOpen = false
  let lastRoutingGuardLogAt = 0

  const ensureRoutingAlignment = async () => {
    if (!started || !client) return false
    if (!config.routingAlignmentEnabled || !workerBuildId || routingAligned || routingGuardFailOpen) {
      return true
    }

    try {
      const describeRequest = { deploymentName: workerDeploymentName } as Parameters<
        TemporalClient['deployments']['describeWorkerDeployment']
      >[0]
      const deployment = await client.deployments.describeWorkerDeployment(
        describeRequest,
        temporalCallOptions({ timeoutMs: DEFAULT_ROUTING_ALIGNMENT_RPC_TIMEOUT_MS }),
      )
      const currentBuildId = extractCurrentDeploymentBuildId(deployment)
      if (currentBuildId === workerBuildId) {
        routingAligned = true
        console.info('[bumba][event-consumer] worker deployment routing already aligned', {
          deploymentName: workerDeploymentName,
          buildId: workerBuildId,
        })
        return true
      }

      const setCurrentVersionRequest = {
        deploymentName: workerDeploymentName,
        buildId: workerBuildId,
        version: '',
        conflictToken: new Uint8Array(),
        allowNoPollers: false,
        ignoreMissingTaskQueues: false,
        identity: `bumba-event-consumer/${process.pid}`,
      } as Parameters<TemporalClient['deployments']['setWorkerDeploymentCurrentVersion']>[0]
      await client.deployments.setWorkerDeploymentCurrentVersion(
        setCurrentVersionRequest,
        temporalCallOptions({ timeoutMs: DEFAULT_ROUTING_ALIGNMENT_RPC_TIMEOUT_MS }),
      )

      routingAligned = true
      console.warn('[bumba][event-consumer] aligned worker deployment routing to active build', {
        deploymentName: workerDeploymentName,
        previousBuildId: currentBuildId ?? null,
        buildId: workerBuildId,
      })
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (isDeploymentApiUnavailableError(error)) {
        routingGuardFailOpen = true
        console.warn('[bumba][event-consumer] deployment routing APIs unavailable; continuing without startup guard', {
          deploymentName: workerDeploymentName,
          buildId: workerBuildId,
          error: errorMessage,
        })
        return true
      }

      const now = Date.now()
      if (now - lastRoutingGuardLogAt >= Math.max(config.pollIntervalMs * 3, 15_000)) {
        const level = isTransientRoutingAlignmentError(error) ? 'warn' : 'error'
        console[level]('[bumba][event-consumer] waiting for worker deployment routing alignment', {
          deploymentName: workerDeploymentName,
          buildId: workerBuildId,
          error: errorMessage,
        })
        lastRoutingGuardLogAt = now
      }
      return false
    }
  }

  const runTick = async () => {
    if (!started || !db || !client) return
    if (!(await ensureRoutingAlignment())) return

    const events = await listPendingGithubEvents(db, config.batchSize)
    if (events.length === 0) return

    for (const event of events) {
      if (inFlightDeliveries.has(event.delivery_id)) continue

      inFlightDeliveries.add(event.delivery_id)
      try {
        const result = await processEvent(db, client, config, event)

        if (result.processed || result.waitingOnIngestion || result.dispatchStarted > 0) {
          dispatchFailureCounts.delete(event.delivery_id)
          continue
        }

        if (result.dispatchFailed > 0) {
          const failures = (dispatchFailureCounts.get(event.delivery_id) ?? 0) + 1
          if (failures >= config.maxDispatchFailures) {
            console.error('[bumba][event-consumer] giving up on event after repeated dispatch failures', {
              deliveryId: event.delivery_id,
              repository: event.repository,
              dispatchFailed: result.dispatchFailed,
              attempts: failures,
            })
            await markEventProcessed(db, event.delivery_id)
            dispatchFailureCounts.delete(event.delivery_id)
          } else {
            dispatchFailureCounts.set(event.delivery_id, failures)
            console.warn('[bumba][event-consumer] retaining event for retry after dispatch failures', {
              deliveryId: event.delivery_id,
              repository: event.repository,
              dispatchFailed: result.dispatchFailed,
              attempts: failures,
              maxAttempts: config.maxDispatchFailures,
            })
          }
        }
      } finally {
        inFlightDeliveries.delete(event.delivery_id)
      }
    }
  }

  const queueTick = () => {
    tickPromise = tickPromise
      .then(() => runTick())
      .catch((error) => {
        console.warn('[bumba][event-consumer] tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return tickPromise
  }

  return {
    start: async () => {
      if (started) return

      if (!config.enabled) {
        console.info('[bumba][event-consumer] disabled')
        return
      }

      db = createSqlClient()
      if (!db) {
        throw new Error('DATABASE_URL is required when BUMBA_GITHUB_EVENT_CONSUMER_ENABLED is true')
      }

      const temporal = await createTemporalClient({ config: temporalConfig })
      client = temporal.client
      started = true

      console.info('[bumba][event-consumer] started', {
        pollIntervalMs: config.pollIntervalMs,
        batchSize: config.batchSize,
        maxDispatchFailures: config.maxDispatchFailures,
        nonterminalIngestionStaleMs: config.nonterminalIngestionStaleMs,
        routingAlignmentEnabled: config.routingAlignmentEnabled,
        workerDeploymentName,
        workerBuildId: workerBuildId ?? null,
        taskQueue: config.taskQueue,
        repoRoot: config.repoRoot,
      })

      await queueTick()
      timer = setInterval(() => {
        void queueTick()
      }, config.pollIntervalMs)
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }

      const wasStarted = started
      started = false

      await tickPromise

      if (client) {
        await client.shutdown().catch(() => undefined)
        client = null
      }

      if (db) {
        await db.close().catch(() => undefined)
        db = null
      }

      if (wasStarted) {
        console.info('[bumba][event-consumer] stopped')
      }
    },
    tick: async () => {
      await queueTick()
    },
    isRunning: () => started,
  }
}

export const __test__ = {
  buildEventWorkflowId,
  extractEventFilePaths,
  resolveEventCommit,
  resolveEventRef,
  resolveConsumerConfig,
  shouldSkipFilePath,
  isWorkflowAlreadyStartedError,
  resolveWorkerDeploymentName,
  extractCurrentDeploymentBuildId,
  isTransientRoutingAlignmentError,
  isDeploymentApiUnavailableError,
  TERMINAL_INGESTION_STATUSES,
}
