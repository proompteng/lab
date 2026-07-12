import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import {
  createTemporalClient,
  type TemporalClient,
  type TemporalConfig,
  temporalCallOptions,
} from '@proompteng/temporal-bun-sdk'
import { VersioningBehavior, WorkflowIdReusePolicy } from '@proompteng/temporal-bun-sdk/worker'
import { SQL } from 'bun'
import { Effect } from 'effect'

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
const MAX_MERGE_DIFF_CHARS = 36_000

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
  failed: number | string | bigint
  nonterminal: number | string | bigint
  oldest_nonterminal_started_at: Date | string | null
}

type GithubEventConsumerConfig = {
  enabled: boolean
  pollIntervalMs: number
  batchSize: number
  maxDispatchEventsPerTick: number
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
  failed: number
  nonterminal: number
  oldestNonterminalStartedAt: number | null
}

type EventEnrichment = {
  path: string
  summary: string
  content: string
}

type GeneratedMemoryNote = {
  summary: string
  content: string
  tags: string[]
}

type MergeDiffFile = {
  path: string
  status: string
  patch: string | null
}

type ProcessEventResult = {
  processed: boolean
  waitingOnIngestion: boolean
  dispatchStarted: number
  dispatchAlreadyStarted: number
  dispatchFailed: number
}

type ProcessEventDependencies = {
  getCounts?: typeof getIngestionCounts
  getWorkflowIds?: typeof listIngestionWorkflowIds
  markProcessed?: typeof markEventProcessed
  markStaleFailed?: typeof markStaleIngestionsFailed
  startWorkflow?: typeof startEventWorkflow
  startMainMergeNoteWorkflow?: typeof startMainMergeNoteWorkflow
}

export type MainMergeMemoryNoteInput = {
  eventId: string
  deliveryId: string
  repoRoot: string
  ref: string
  commit: string
}

type EventConsumerTickDependencies = {
  db: SqlClient
  client: TemporalClient
  config: GithubEventConsumerConfig
  inFlightDeliveries: Set<string>
  dispatchFailureCounts: Map<string, number>
  ensureRoutingAlignment: () => Promise<boolean>
  listPendingEvents?: typeof listPendingGithubEvents
  processPendingEvent?: typeof processEvent
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

const resolveConsumerConfig = (): GithubEventConsumerConfig => {
  const batchSize = parsePositiveInt(process.env.BUMBA_GITHUB_EVENT_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  return {
    enabled: parseBoolean(process.env.BUMBA_GITHUB_EVENT_CONSUMER_ENABLED, true),
    pollIntervalMs: parsePositiveInt(process.env.BUMBA_GITHUB_EVENT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    batchSize,
    maxDispatchEventsPerTick: parsePositiveInt(process.env.BUMBA_GITHUB_EVENT_MAX_DISPATCH_EVENTS_PER_TICK, batchSize),
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
  }
}

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

const extractEventFilePaths = (payload: Record<string, unknown>) => {
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

  return Array.from(paths).sort()
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

const isMainBranchRef = (ref: string) => ref === 'main' || ref === 'refs/heads/main'

const mainMergeMemoryNamespace = (deliveryId: string) => `bumba-main-${deliveryId}`.slice(0, 200)

const buildMainMergeNoteWorkflowId = (deliveryId: string) => `bumba-main-note-${shortHash(deliveryId)}`

const requestAgentsJsonEffect = (path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const baseUrl = (process.env.AGENTS_SERVICE_BASE_URL ?? 'http://agents.agents.svc.cluster.local').replace(
        /\/+$/,
        '',
      )
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          'x-agents-client': 'bumba',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...init?.headers,
        },
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      })
      const body = (await response.json().catch(() => null)) as unknown
      if (!response.ok) {
        const error = normalizeOptionalText(asRecord(body)?.error) ?? response.statusText ?? 'unknown error'
        throw new Error(`Agents request failed (${response.status}): ${error}`)
      }
      const record = asRecord(body)
      if (!record) throw new Error('Agents request returned an invalid JSON body')
      return record
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const countMainMergeMemoryNotesEffect = (namespace: string) =>
  Effect.flatMap(
    requestAgentsJsonEffect(`/v1/memory-notes/count?namespace=${encodeURIComponent(namespace)}`),
    (body) => {
      const count = body.count
      if (typeof count === 'number' && Number.isFinite(count)) return Effect.succeed(count)
      if (typeof count === 'string' && /^\d+$/.test(count)) return Effect.succeed(Number.parseInt(count, 10))
      return Effect.fail(new Error('Agents memory-note count response did not include a valid count'))
    },
  )

const persistMainMergeMemoryNoteEffect = (input: {
  namespace: string
  summary: string
  content: string
  tags: string[]
  metadata: Record<string, unknown>
}) =>
  Effect.asVoid(
    requestAgentsJsonEffect('/v1/memory-notes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )

const loadMainMergeEnrichmentsEffect = (db: SqlClient, eventId: string, commit: string) =>
  Effect.tryPromise({
    try: async () =>
      (await db`
    SELECT DISTINCT ON (fk.path)
      fk.path,
      COALESCE(e.summary, '') AS summary,
      e.content
    FROM atlas.event_files ef
    JOIN atlas.file_keys fk ON fk.id = ef.file_key_id
    JOIN atlas.file_versions fv
      ON fv.file_key_id = fk.id
     AND fv.repository_commit = ${commit}
    JOIN atlas.enrichments e
      ON e.file_version_id = fv.id
     AND e.kind = 'model_enrichment'
     AND e.source = 'bumba'
     AND e.chunk_id IS NULL
    WHERE ef.event_id = ${eventId}
    ORDER BY fk.path, e.created_at DESC;
      `) as EventEnrichment[],
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const loadMainMergeEnrichments = (db: SqlClient, eventId: string, commit: string): Promise<EventEnrichment[]> =>
  Effect.runPromise(loadMainMergeEnrichmentsEffect(db, eventId, commit))

const loadMainMergeDiffEffect = (
  repoRoot: string,
  payload: Record<string, unknown>,
  commit: string,
): Effect.Effect<MergeDiffFile[], Error> =>
  Effect.tryPromise({
    try: async () => {
      const before = normalizeOptionalText(payload.before)
      if (!before || /^0+$/.test(before)) return []

      const runGit = async (args: string[], allowFailure = false) => {
        const child = Bun.spawn(['git', ...args], {
          cwd: repoRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (exitCode !== 0 && !allowFailure) {
          throw new Error(`git ${args[0] ?? 'command'} failed (${exitCode}): ${stderr.trim().slice(0, 1_000)}`)
        }
        return { exitCode, stdout }
      }

      const beforeExists = (await runGit(['cat-file', '-e', `${before}^{commit}`], true)).exitCode === 0
      const commitExists = (await runGit(['cat-file', '-e', `${commit}^{commit}`], true)).exitCode === 0
      if (!beforeExists || !commitExists) {
        await runGit(['fetch', '--no-tags', '--depth=2', 'origin', before, commit])
      }

      const changedPaths = (await runGit(['diff', '--name-only', '-z', before, commit])).stdout
        .split('\0')
        .filter((path) => path.length > 0)

      const prioritizedPaths = changedPaths.sort(
        (left, right) => mergeContextPriority(left) - mergeContextPriority(right),
      )
      const diffFiles: MergeDiffFile[] = []
      let collectedChars = 0
      for (const path of prioritizedPaths) {
        if (collectedChars >= MAX_MERGE_DIFF_CHARS) break
        const rawPatch = (
          await runGit(['diff', '--no-ext-diff', '--unified=3', before, commit, '--', path])
        ).stdout.trim()
        const perFileLimit = mergeContextPriority(path) === 0 ? 24_000 : 4_000
        const remainingChars = MAX_MERGE_DIFF_CHARS - collectedChars
        const patch = rawPatch.slice(0, Math.min(perFileLimit, remainingChars))
        diffFiles.push({ path, status: 'changed', patch: patch || null })
        collectedChars += patch.length
      }
      return diffFiles
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const loadMainMergeDiff = (
  repoRoot: string,
  payload: Record<string, unknown>,
  commit: string,
): Promise<MergeDiffFile[]> => Effect.runPromise(loadMainMergeDiffEffect(repoRoot, payload, commit))

const normalizeGeneratedMemoryNote = (raw: unknown): GeneratedMemoryNote => {
  const record = asRecord(raw)
  const summary = normalizeOptionalText(record?.summary)
  const content = normalizeOptionalText(record?.content)
  const tags = Array.isArray(record?.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag, index, values) => tag.length > 0 && tag.length <= 64 && values.indexOf(tag) === index)
        .slice(0, 12)
    : []

  if (!summary || !content) {
    throw new Error('Flamingo merge-note response must include non-empty summary and content')
  }

  return {
    summary: summary.slice(0, 1_000),
    content: content.slice(0, 48_000),
    tags,
  }
}

const mergeContextPriority = (path: string) => {
  if (/(?:^|\/)src\//.test(path) && !/\.(?:test|spec)\.[^.]+$/.test(path)) return 0
  if (path.endsWith('/package.json')) return 1
  if (/readme|runbook|design/i.test(path)) return 2
  if (/\.(?:test|spec)\.[^.]+$/.test(path)) return 3
  return 4
}

const generateMainMergeMemoryNoteEffect = (
  event: GithubEventRow,
  payload: Record<string, unknown>,
  enrichments: EventEnrichment[],
  diffFiles: MergeDiffFile[],
): Effect.Effect<GeneratedMemoryNote, Error> =>
  Effect.tryPromise({
    try: async () => {
      const apiBaseUrl = (
        process.env.OPENAI_API_BASE_URL ??
        process.env.OPENAI_API_BASE ??
        'http://flamingo.flamingo.svc.cluster.local/v1'
      ).replace(/\/+$/, '')
      const model = normalizeOptionalText(process.env.OPENAI_COMPLETION_MODEL) ?? 'qwen36-flamingo'
      const reasoningEffort = normalizeOptionalText(process.env.BUMBA_MERGE_NOTE_REASONING_EFFORT) ?? 'none'
      const timeoutMs = parsePositiveInt(process.env.OPENAI_COMPLETION_TIMEOUT_MS, 300_000)
      const maxOutputTokens = parsePositiveInt(process.env.OPENAI_COMPLETION_MAX_OUTPUT_TOKENS, 1_024)
      const commitMessage = normalizeOptionalText(asRecord(payload.head_commit)?.message)

      const enrichmentSections: string[] = []
      let enrichmentChars = 0
      const prioritizedEnrichments = [...enrichments].sort(
        (left, right) => mergeContextPriority(left.path) - mergeContextPriority(right.path),
      )
      for (const enrichment of prioritizedEnrichments) {
        const section = [`File: ${enrichment.path}`, `Summary: ${enrichment.summary}`, enrichment.content].join('\n')
        if (enrichmentChars + section.length > 12_000) break
        enrichmentSections.push(section)
        enrichmentChars += section.length
      }

      const diffSections: string[] = []
      let diffChars = 0
      const prioritizedDiffs = [...diffFiles].sort(
        (left, right) => mergeContextPriority(left.path) - mergeContextPriority(right.path),
      )
      for (const file of prioritizedDiffs) {
        const perFileLimit = mergeContextPriority(file.path) === 0 ? 24_000 : 4_000
        const patch = file.patch ? file.patch.slice(0, perFileLimit) : null
        const section = [
          `File: ${file.path} (${file.status})`,
          patch ?? '[GitHub did not provide a textual patch for this file.]',
          file.patch && file.patch.length > perFileLimit ? '[Patch truncated at the context boundary.]' : null,
        ].join('\n')
        if (diffChars + section.length > 36_000) break
        diffSections.push(section)
        diffChars += section.length
      }

      const systemPrompt = [
        'You create durable engineering memory for future coding agents.',
        'Synthesize the supplied file enrichments into knowledge that is not recoverable from a filename list or git log alone.',
        'Capture system behavior, important relationships, decisions or invariants, operational consequences, and risks.',
        'Use the merge diff as the authority for what changed and the enrichments as context for current system behavior.',
        'Lead with the primary runtime behavior and the failure mode it fixes.',
        'Treat dependency hashes, CI wiring, documentation, and tests as supporting evidence unless they change runtime semantics.',
        'State only behavior directly proven by the supplied diff or enrichment; omit uncertain interpretations.',
        'Do not describe a retry, completion condition, error path, or side-effect ordering unless the evidence explicitly proves it.',
        'Keep Flamingo completion and the Agents memory endpoint distinct.',
        'Context limits are measured in characters, never tokens.',
        'Include risks only when demonstrated by the evidence; do not add generic cost, coupling, rate-limit, or performance speculation.',
        'Do not narrate the commit metadata, enumerate every file, or claim facts absent from the evidence.',
        'The content should make the durable invariant, retry/failure behavior, completion gate, and operational consequence easy to retrieve.',
        'Keep content under 1800 characters and prefer identifiers or exact conditions over broad paraphrases.',
        'Return one JSON object with exactly: summary (one concise sentence), content (concise markdown), and tags (3-8 retrieval tags).',
        'If enrichment failed or evidence is incomplete, state that limitation explicitly.',
      ].join(' ')
      const userPrompt = [
        `Repository: ${event.repository}`,
        ...(commitMessage ? [`Merge context: ${commitMessage}`] : []),
        `Successful file enrichments: ${enrichments.length}`,
        enrichmentSections.length > 0
          ? `Semantic enrichments:\n\n${enrichmentSections.join('\n\n')}`
          : 'No successful file enrichments were available.',
        diffSections.length > 0
          ? `Merge diff:\n\n${diffSections.join('\n\n')}`
          : 'No textual merge diff was available; do not infer exact code changes.',
      ].join('\n\n')

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const apiKey = normalizeOptionalText(process.env.OPENAI_API_KEY)
      if (apiKey) headers.authorization = `Bearer ${apiKey}`

      const response = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: maxOutputTokens,
          temperature: 0.1,
          top_p: 0.8,
          reasoning_effort: reasoningEffort,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new Error(
          `Flamingo merge-note completion failed (${response.status}): ${(await response.text()).slice(0, 1_000)}`,
        )
      }

      const completion = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const rawContent = completion.choices?.[0]?.message?.content
      if (typeof rawContent !== 'string') {
        throw new Error('Flamingo merge-note completion returned no message content')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawContent)
      } catch {
        throw new Error('Flamingo merge-note completion returned invalid JSON')
      }
      return normalizeGeneratedMemoryNote(parsed)
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const generateMainMergeMemoryNote = (
  event: GithubEventRow,
  payload: Record<string, unknown>,
  enrichments: EventEnrichment[],
  diffFiles: MergeDiffFile[],
): Promise<GeneratedMemoryNote> =>
  Effect.runPromise(generateMainMergeMemoryNoteEffect(event, payload, enrichments, diffFiles))

const publishMainMergeMemoryNoteEffect = (
  db: SqlClient,
  repoRoot: string,
  event: GithubEventRow,
  payload: Record<string, unknown>,
  ref: string,
  commit: string,
  files: string[],
  counts: IngestionCounts,
  dependencies: {
    loadEnrichments?: typeof loadMainMergeEnrichments
    loadDiff?: typeof loadMainMergeDiff
    generateNote?: typeof generateMainMergeMemoryNote
  } = {},
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!isMainBranchRef(ref)) return

    const namespace = mainMergeMemoryNamespace(event.delivery_id)
    if ((yield* countMainMergeMemoryNotesEffect(namespace)) > 0) return

    const enrichments = dependencies.loadEnrichments
      ? yield* Effect.tryPromise({
          try: () => dependencies.loadEnrichments!(db, event.id, commit),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      : yield* loadMainMergeEnrichmentsEffect(db, event.id, commit)
    const diffFiles = dependencies.loadDiff
      ? yield* Effect.tryPromise({
          try: () => dependencies.loadDiff!(repoRoot, payload, commit),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      : yield* loadMainMergeDiffEffect(repoRoot, payload, commit)
    const note = dependencies.generateNote
      ? yield* Effect.tryPromise({
          try: () => dependencies.generateNote!(event, payload, enrichments, diffFiles),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      : yield* generateMainMergeMemoryNoteEffect(event, payload, enrichments, diffFiles)

    yield* persistMainMergeMemoryNoteEffect({
      namespace,
      summary: note.summary,
      content: note.content,
      tags: Array.from(new Set(['bumba', 'main', 'merge', ...note.tags])).slice(0, 12),
      metadata: {
        deliveryId: event.delivery_id,
        repository: event.repository,
        ref,
        commit,
        fileCount: files.length,
        ingestionTotal: counts.total,
        ingestionFailed: counts.failed,
        enrichmentCount: enrichments.length,
        diffFileCount: diffFiles.length,
        noteModel: normalizeOptionalText(process.env.OPENAI_COMPLETION_MODEL) ?? 'qwen36-flamingo',
      },
    })
  })

const publishMainMergeMemoryNote = (
  db: SqlClient,
  repoRoot: string,
  event: GithubEventRow,
  payload: Record<string, unknown>,
  ref: string,
  commit: string,
  files: string[],
  counts: IngestionCounts,
  dependencies: {
    loadEnrichments?: typeof loadMainMergeEnrichments
    loadDiff?: typeof loadMainMergeDiff
    generateNote?: typeof generateMainMergeMemoryNote
  } = {},
): Promise<void> =>
  Effect.runPromise(
    publishMainMergeMemoryNoteEffect(db, repoRoot, event, payload, ref, commit, files, counts, dependencies),
  )

export const publishMainMergeMemoryNoteActivity = async (input: MainMergeMemoryNoteInput): Promise<void> => {
  const databaseUrl = normalizeOptionalText(process.env.DATABASE_URL)
  if (!databaseUrl) throw new Error('DATABASE_URL is required to publish a main-merge memory note')

  const db = new SQL(withDefaultSslMode(databaseUrl))
  try {
    const rows = (await db`
      SELECT id, delivery_id, event_type, repository, payload
      FROM atlas.github_events
      WHERE id = ${input.eventId}
        AND delivery_id = ${input.deliveryId}
      LIMIT 1;
    `) as GithubEventRow[]
    const event = rows[0]
    if (!event) throw new Error(`GitHub event ${input.eventId} was not found for merge-note publication`)

    const payload = resolveEventPayload(event.payload)
    const files = extractEventFilePaths(payload)
    const counts = await getIngestionCounts(db, event.id)
    await publishMainMergeMemoryNote(db, input.repoRoot, event, payload, input.ref, input.commit, files, counts)
  } finally {
    await db.close().catch(() => undefined)
  }
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
      count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
      count(*) FILTER (WHERE status NOT IN ('completed', 'failed', 'skipped'))::bigint AS nonterminal,
      min(started_at) FILTER (WHERE status NOT IN ('completed', 'failed', 'skipped')) AS oldest_nonterminal_started_at
    FROM atlas.ingestions
    WHERE event_id = ${eventId};
  `) as IngestionCountsRow[]

  const row = rows[0]
  if (!row) return { total: 0, terminal: 0, failed: 0, nonterminal: 0, oldestNonterminalStartedAt: null }

  return {
    total: toNumber(row.total),
    terminal: toNumber(row.terminal),
    failed: toNumber(row.failed),
    nonterminal: toNumber(row.nonterminal),
    oldestNonterminalStartedAt: toEpochMs(row.oldest_nonterminal_started_at),
  }
}

const listIngestionWorkflowIds = async (db: SqlClient, eventId: string): Promise<Set<string>> => {
  const rows = (await db`
    SELECT workflow_id
    FROM atlas.ingestions
    WHERE event_id = ${eventId};
  `) as Array<{ workflow_id: string }>
  return new Set(rows.map((row) => row.workflow_id))
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
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
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

const startMainMergeNoteWorkflow = async (
  client: TemporalClient,
  config: GithubEventConsumerConfig,
  input: MainMergeMemoryNoteInput,
) => {
  try {
    await client.workflow.start({
      workflowId: buildMainMergeNoteWorkflowId(input.deliveryId),
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowType: 'publishMainMergeMemoryNote',
      taskQueue: config.taskQueue,
      versioningBehavior: VersioningBehavior.AUTO_UPGRADE,
      args: [input],
    })
  } catch (error) {
    if (!isWorkflowAlreadyStartedError(error)) throw error
  }
}

const processEvent = async (
  db: SqlClient,
  client: TemporalClient,
  config: GithubEventConsumerConfig,
  event: GithubEventRow,
  dependencies: ProcessEventDependencies = {},
): Promise<ProcessEventResult> => {
  const getCounts = dependencies.getCounts ?? getIngestionCounts
  const getWorkflowIds = dependencies.getWorkflowIds ?? listIngestionWorkflowIds
  const markProcessed = dependencies.markProcessed ?? markEventProcessed
  const markStaleFailed = dependencies.markStaleFailed ?? markStaleIngestionsFailed
  const startWorkflow = dependencies.startWorkflow ?? startEventWorkflow
  const startMergeNoteWorkflow = dependencies.startMainMergeNoteWorkflow ?? startMainMergeNoteWorkflow

  if (event.event_type !== 'push') {
    await markProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchAlreadyStarted: 0,
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
    await markProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchAlreadyStarted: 0,
      dispatchFailed: 0,
    }
  }

  const files = extractEventFilePaths(payload)
  if (files.length === 0) {
    console.info('[bumba][event-consumer] skipping push event without indexable files', {
      deliveryId: event.delivery_id,
      repository: event.repository,
    })
    await markProcessed(db, event.delivery_id)
    return {
      processed: true,
      waitingOnIngestion: false,
      dispatchStarted: 0,
      dispatchAlreadyStarted: 0,
      dispatchFailed: 0,
    }
  }

  let ingestionCounts = await getCounts(db, event.id)
  if (ingestionCounts.nonterminal > 0) {
    const oldestNonterminalStartedAt = ingestionCounts.oldestNonterminalStartedAt
    const isStaleBlocked =
      ingestionCounts.nonterminal > 0 &&
      oldestNonterminalStartedAt !== null &&
      Date.now() - oldestNonterminalStartedAt >= config.nonterminalIngestionStaleMs

    if (isStaleBlocked) {
      const staleFailed = await markStaleFailed(db, event.id, config.nonterminalIngestionStaleMs)
      if (staleFailed > 0) {
        console.warn('[bumba][event-consumer] auto-failed stale nonterminal ingestions', {
          deliveryId: event.delivery_id,
          repository: event.repository,
          staleFailed,
          staleAfterMs: config.nonterminalIngestionStaleMs,
        })
        ingestionCounts = await getCounts(db, event.id)
      }
    }
  }

  const ref = resolveEventRef(payload)
  const ingestionWorkflowIds = await getWorkflowIds(db, event.id)

  let started = 0
  let alreadyStarted = 0
  let failed = 0
  let scanned = 0
  let startAttempts = 0

  for (const filePath of files) {
    const workflowId = buildEventWorkflowId(event.delivery_id, filePath)
    if (ingestionWorkflowIds.has(workflowId)) {
      alreadyStarted += 1
      scanned += 1
      continue
    }
    if (startAttempts >= config.maxEventFileTargets) break
    scanned += 1
    startAttempts += 1
    try {
      await startWorkflow(client, config, event, filePath, ref, commit)
      started += 1
    } catch (error) {
      if (isWorkflowAlreadyStartedError(error)) {
        alreadyStarted += 1
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

  const allTargetsDispatched = scanned === files.length && failed === 0
  ingestionCounts = await getCounts(db, event.id)
  if (allTargetsDispatched && ingestionCounts.total >= files.length) {
    if (ingestionCounts.total === ingestionCounts.terminal) {
      if (isMainBranchRef(ref)) {
        await startMergeNoteWorkflow(client, config, {
          eventId: event.id,
          deliveryId: event.delivery_id,
          repoRoot: config.repoRoot,
          ref,
          commit,
        })
      }
      await markProcessed(db, event.delivery_id)
      return {
        processed: true,
        waitingOnIngestion: false,
        dispatchStarted: started,
        dispatchAlreadyStarted: alreadyStarted,
        dispatchFailed: failed,
      }
    }

    return {
      processed: false,
      waitingOnIngestion: true,
      dispatchStarted: started,
      dispatchAlreadyStarted: alreadyStarted,
      dispatchFailed: failed,
    }
  }

  if (started > 0 || alreadyStarted > 0) {
    console.info('[bumba][event-consumer] dispatched event workflows', {
      deliveryId: event.delivery_id,
      repository: event.repository,
      started,
      alreadyStarted,
      failed,
      files: files.length,
    })
    return {
      processed: false,
      waitingOnIngestion: false,
      dispatchStarted: started,
      dispatchAlreadyStarted: alreadyStarted,
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
    dispatchAlreadyStarted: 0,
    dispatchFailed: failed,
  }
}

const runEventConsumerTickEffect = ({
  db,
  client,
  config,
  inFlightDeliveries,
  dispatchFailureCounts,
  ensureRoutingAlignment,
  listPendingEvents = listPendingGithubEvents,
  processPendingEvent = processEvent,
}: EventConsumerTickDependencies): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const routingAligned = yield* Effect.tryPromise({
      try: ensureRoutingAlignment,
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    if (!routingAligned) return

    const events = yield* Effect.tryPromise({
      try: () => listPendingEvents(db, config.batchSize),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })

    let dispatchedEvents = 0
    yield* Effect.forEach(
      events,
      (event) => {
        if (dispatchedEvents >= config.maxDispatchEventsPerTick || inFlightDeliveries.has(event.delivery_id)) {
          return Effect.void
        }

        inFlightDeliveries.add(event.delivery_id)
        return Effect.tryPromise({
          try: () => processPendingEvent(db, client, config, event),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.dispatchStarted > 0) dispatchedEvents += 1

              if (result.dispatchFailed > 0) {
                const failures = (dispatchFailureCounts.get(event.delivery_id) ?? 0) + 1
                if (failures >= config.maxDispatchFailures) {
                  console.error('[bumba][event-consumer] event remains pending after repeated dispatch failures', {
                    deliveryId: event.delivery_id,
                    repository: event.repository,
                    dispatchFailed: result.dispatchFailed,
                    attempts: failures,
                  })
                  dispatchFailureCounts.set(event.delivery_id, config.maxDispatchFailures)
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
                return
              }

              if (
                result.processed ||
                result.waitingOnIngestion ||
                result.dispatchStarted > 0 ||
                result.dispatchAlreadyStarted > 0
              ) {
                dispatchFailureCounts.delete(event.delivery_id)
              }
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn('[bumba][event-consumer] event processing failed; retaining event for retry', {
                deliveryId: event.delivery_id,
                repository: event.repository,
                error: error.message,
              })
            }),
          ),
          Effect.ensuring(Effect.sync(() => inFlightDeliveries.delete(event.delivery_id))),
        )
      },
      { concurrency: 1, discard: true },
    )
  })

const runEventConsumerTick = (dependencies: EventConsumerTickDependencies): Promise<void> =>
  Effect.runPromise(runEventConsumerTickEffect(dependencies))

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
      const deployment = await client.deployments.describeWorkerDeployment(
        { deploymentName: workerDeploymentName },
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

      await client.deployments.setWorkerDeploymentCurrentVersion(
        {
          deploymentName: workerDeploymentName,
          buildId: workerBuildId,
          allowNoPollers: false,
          ignoreMissingTaskQueues: false,
          identity: `bumba-event-consumer/${process.pid}`,
        },
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
    await runEventConsumerTick({
      db,
      client,
      config,
      inFlightDeliveries,
      dispatchFailureCounts,
      ensureRoutingAlignment,
    })
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
        maxDispatchEventsPerTick: config.maxDispatchEventsPerTick,
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
  buildMainMergeNoteWorkflowId,
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
  runEventConsumerTick,
  processEvent,
  startEventWorkflow,
  startMainMergeNoteWorkflow,
  publishMainMergeMemoryNote,
  loadMainMergeEnrichments,
  loadMainMergeDiff,
  generateMainMergeMemoryNote,
  normalizeGeneratedMemoryNote,
  isMainBranchRef,
  mainMergeMemoryNamespace,
  TERMINAL_INGESTION_STATUSES,
}
