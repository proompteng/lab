#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { parseAtlasGitTree, type AtlasGitManifest } from '@proompteng/bumba/atlas/reconciliation'
import { SQL } from 'bun'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

type GoldQuery = {
  query: string
  expectedPaths: string[]
  expectedFirst?: boolean
}

type GoldSet = {
  version: string
  repository: string
  ref: string
  queries: GoldQuery[]
  absentPaths: string[]
}

type Options = {
  repoRoot: string
  repository: string
  ref: string
  databaseUrl: string
  baseUrl: string
  goldSetPath: string
  performanceRuns: number
  concurrency: number
  json: boolean
}

type RepositoryRow = {
  id: string
  default_ref: string
  metadata: Record<string, unknown> | string | null
}

type IndexedFileRow = {
  path: string
  repository_commit: string | null
  content_hash: string | null
  git_object_id: string | null
  chunks: unknown
  embeddings: unknown
  chunk_metadata_mismatches: unknown
  ranges: unknown
}

type CodeSearchItem = {
  repository?: string
  ref?: string
  path?: string
  commit?: string
  startLine?: number | null
  endLine?: number | null
  contentHash?: string
  retrievalMode?: string
  degradation?: string | null
}

type CodeSearchResponse = {
  ok?: boolean
  error?: string
  message?: string
  items?: CodeSearchItem[]
  indexHealth?: { status?: string; indexedCommit?: string }
}

const DEFAULT_GOLD_SET = resolve(defaultRepoRoot, 'docs/atlas/query-gold-set.json')
const CANCELLATION_DRAIN_DEADLINE_MS = 500
const CANCELLATION_DRAIN_POLL_MS = 25

const usage = () =>
  `
Usage:
  bun run atlas:verify [options]

Options:
      --repo-root <path>       Local Git checkout (default: repository root)
      --repository <slug>      Repository slug (default: proompteng/lab)
      --ref <ref>              Ref to verify (default: main)
      --database-url <url>     Atlas PostgreSQL URL (default: DATABASE_URL)
      --base-url <url>         Jangar URL (default: ATLAS_BASE_URL or shared Jangar)
      --gold-set <path>        Fixed query set (default: docs/atlas/query-gold-set.json)
      --performance-runs <n>   Runs per query for latency gates (default: 3)
      --concurrency <n>        Search concurrency (default: 4)
      --json                   Print only the verification report
  -h, --help                   Show this help
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) fatal(`${arg} requires a value`)
  return value
}

const positiveInt = (arg: string, raw: string) => {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) fatal(`${arg} must be a positive integer`)
  return value
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

const parseArgs = (argv: string[]): Options => {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  const options: Partial<Options> = {
    repoRoot: defaultRepoRoot,
    repository: 'proompteng/lab',
    ref: 'main',
    databaseUrl,
    baseUrl: trimSlash(process.env.ATLAS_BASE_URL ?? process.env.JANGAR_BASE_URL ?? 'http://jangar.ide-newton.ts.net'),
    goldSetPath: DEFAULT_GOLD_SET,
    performanceRuns: 3,
    concurrency: 4,
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const raw = equals === -1 ? readValue(arg, argv, index) : arg.slice(equals + 1)
    if (equals === -1) index += 1
    if (name === '--repo-root') options.repoRoot = raw
    else if (name === '--repository') options.repository = raw
    else if (name === '--ref') options.ref = raw
    else if (name === '--database-url') options.databaseUrl = raw
    else if (name === '--base-url') options.baseUrl = trimSlash(raw)
    else if (name === '--gold-set') options.goldSetPath = raw
    else if (name === '--performance-runs') options.performanceRuns = positiveInt(name, raw)
    else if (name === '--concurrency') options.concurrency = positiveInt(name, raw)
    else fatal(`Unknown option: ${arg}`)
  }

  if (!options.databaseUrl) fatal('DATABASE_URL or --database-url is required')
  if (options.ref !== 'main') fatal('Atlas verification accepts only --ref main')
  return options as Options
}

const withDefaultSslMode = (rawUrl: string) => {
  const url = new URL(rawUrl)
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', process.env.PGSSLMODE?.trim() || 'require')
  return url.toString()
}

const runGit = async (repoRoot: string, args: string[]) => {
  const process = Bun.spawn(['git', '-C', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  return stdout
}

const loadAuthoritativeManifest = async (repoRoot: string, ref: string) => {
  await runGit(repoRoot, [
    'fetch',
    '--no-auto-maintenance',
    '--quiet',
    'origin',
    `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
  ])
  const commit = (await runGit(repoRoot, ['rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`])).trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`origin/${ref} did not resolve to an exact commit`)
  const tree = await runGit(repoRoot, ['ls-tree', '-r', '-z', '--long', commit])
  return { commit, manifest: parseAtlasGitTree(tree) }
}

const parseMetadata = (value: RepositoryRow['metadata']) => {
  if (!value) return {}
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  }
  return value
}

const count = (value: unknown) => {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 10)
  return 0
}

const ranges = (value: unknown): Array<[number, number]> => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return []
    const start = Number(entry[0])
    const end = Number(entry[1])
    return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start ? [[start, end]] : []
  })
}

const loadGitBlobs = async (repoRoot: string, manifest: AtlasGitManifest) => {
  const objectIds = [...new Set(manifest.files.map((file) => file.objectId))]
  const process = Bun.spawn(['git', '-C', repoRoot, 'cat-file', '--batch'], {
    cwd: repoRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!process.stdin || typeof process.stdin === 'number') throw new Error('failed to open git cat-file stdin')
  process.stdin.write(`${objectIds.join('\n')}\n`)
  process.stdin.end()

  const blobs = new Map<string, Buffer>()
  const reader = process.stdout.getReader()
  let pending = Buffer.alloc(0)
  let header: { objectId: string; size: number } | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (value) pending = Buffer.concat([pending, Buffer.from(value)])

    while (true) {
      if (!header) {
        const newline = pending.indexOf(0x0a)
        if (newline === -1) break
        const rawHeader = pending.subarray(0, newline).toString('utf8')
        pending = pending.subarray(newline + 1)
        const match = rawHeader.match(/^([0-9a-f]{40}) blob (\d+)$/i)
        if (!match?.[1] || !match[2]) throw new Error(`unexpected git cat-file header: ${rawHeader}`)
        header = { objectId: match[1], size: Number.parseInt(match[2], 10) }
      }
      if (pending.length < header.size + 1) break
      if (pending[header.size] !== 0x0a) throw new Error(`invalid git cat-file delimiter for ${header.objectId}`)
      blobs.set(header.objectId, Buffer.from(pending.subarray(0, header.size)))
      pending = pending.subarray(header.size + 1)
      header = null
    }
    if (done) break
  }

  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited])
  if (exitCode !== 0) throw new Error(`git cat-file failed: ${stderr.trim()}`)
  if (header || pending.length > 0 || blobs.size !== objectIds.length) {
    throw new Error(`git cat-file returned ${blobs.size} of ${objectIds.length} requested blobs`)
  }
  return blobs
}

const percentile = (values: number[], quantile: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

const search = async (baseUrl: string, repository: string, ref: string, query: string) => {
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}/api/code-search`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query, repository, ref, limit: 10 }),
  })
  const payload = (await response.json()) as CodeSearchResponse
  if (!response.ok || payload.ok === false) {
    throw new Error(`query ${JSON.stringify(query)} failed (${response.status}): ${payload.error ?? payload.message}`)
  }
  return { payload, durationMs: performance.now() - startedAt }
}

const runWithConcurrency = async <T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) => {
  const output: R[] = []
  for (let index = 0; index < items.length; index += concurrency) {
    output.push(...(await Promise.all(items.slice(index, index + concurrency).map(task))))
  }
  return output
}

const buildColdPerformanceQueries = (queries: GoldQuery[], runs: number, nonce: string = randomUUID()) =>
  Array.from({ length: runs }, (_, run) =>
    queries.map((fixture, index) => `${fixture.query}\nAtlas latency probe ${nonce}-${run}-${index}`),
  ).flat()

const absentPathSearchError = (path: string, paths: string[]) =>
  paths.length === 0
    ? undefined
    : `deleted path search returned ${paths.length} result(s) for ${path}: ${paths.join(', ')}`

const activeAtlasQueryCount = async (db: SQL) => {
  const rows = (await db`
    SELECT count(DISTINCT activity.pid)::bigint AS active
    FROM pg_stat_activity AS activity
    INNER JOIN pg_locks AS relation_lock ON relation_lock.pid = activity.pid
    WHERE activity.state = 'active'
      AND relation_lock.locktype = 'relation'
      AND relation_lock.relation = 'atlas.chunk_embeddings'::regclass
      AND activity.pid <> pg_backend_pid();
  `) as Array<{ active: unknown }>
  return count(rows[0]?.active)
}

const waitForAtlasQueryDrain = async (input: {
  activeQueryCount: () => Promise<number>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  deadlineMs?: number
  pollMs?: number
}) => {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? Bun.sleep
  const deadlineMs = input.deadlineMs ?? CANCELLATION_DRAIN_DEADLINE_MS
  const pollMs = input.pollMs ?? CANCELLATION_DRAIN_POLL_MS
  const deadline = now() + deadlineMs
  let activeQueries = await input.activeQueryCount()
  while (activeQueries > 0 && now() < deadline) {
    await sleep(pollMs)
    activeQueries = await input.activeQueryCount()
  }
  return activeQueries
}

const runCancellationProbe = async (input: {
  db: SQL
  baseUrl: string
  repository: string
  ref: string
  concurrency: number
}) => {
  const query = `Atlas cancellation probe ${randomUUID()}`

  // Populate only this query's server-side embedding cache so the canceled requests are guaranteed to reach SQL.
  await search(input.baseUrl, input.repository, input.ref, query)

  let markLockReady: () => void = () => undefined
  let releaseLock: () => void = () => undefined
  const lockReady = new Promise<void>((resolve) => {
    markLockReady = resolve
  })
  const lockRelease = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const lockTask = input.db.begin(async (transaction) => {
    await transaction`LOCK TABLE atlas.chunk_embeddings IN ACCESS EXCLUSIVE MODE;`
    markLockReady()
    await lockRelease
  })

  let reachedDatabase = false
  let observedBlockedQueries = 0
  let lingeringQueries = 0
  try {
    await Promise.race([
      lockReady,
      lockTask.then(() => {
        throw new Error('Atlas cancellation probe lock transaction ended before acquiring the lock')
      }),
      Bun.sleep(5_000).then(() => {
        throw new Error('timed out acquiring the Atlas cancellation probe lock')
      }),
    ])

    const controllers = Array.from({ length: input.concurrency }, () => new AbortController())
    const requests = controllers.map((controller) =>
      fetch(`${input.baseUrl}/api/code-search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, repository: input.repository, ref: input.ref }),
        signal: controller.signal,
      })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined),
    )

    const observeDeadline = Date.now() + 750
    while (Date.now() < observeDeadline) {
      observedBlockedQueries = Math.max(observedBlockedQueries, await activeAtlasQueryCount(input.db))
      if (observedBlockedQueries > 0) {
        reachedDatabase = true
        break
      }
      await Bun.sleep(25)
    }

    for (const controller of controllers) controller.abort(new Error('Atlas live cancellation probe'))
    await Promise.all(requests)
    lingeringQueries = await waitForAtlasQueryDrain({
      activeQueryCount: () => activeAtlasQueryCount(input.db),
    })
  } finally {
    releaseLock()
    await lockTask
  }

  return { reachedDatabase, observedBlockedQueries, lingeringQueries }
}

export const __private = {
  absentPathSearchError,
  activeAtlasQueryCount,
  buildColdPerformanceQueries,
  cancellationDrainDeadlineMs: CANCELLATION_DRAIN_DEADLINE_MS,
  waitForAtlasQueryDrain,
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const gold = (await Bun.file(resolve(options.goldSetPath)).json()) as GoldSet
  if (gold.repository !== options.repository || gold.ref !== options.ref || !Array.isArray(gold.queries)) {
    throw new Error('gold set repository/ref/queries do not match the verification target')
  }

  const repoRoot = resolve(options.repoRoot)
  const { commit: gitHead, manifest } = await loadAuthoritativeManifest(repoRoot, options.ref)
  const blobs = await loadGitBlobs(repoRoot, manifest)
  const db = new SQL(withDefaultSslMode(options.databaseUrl))
  const errors: string[] = []

  try {
    const repositoryRows = (await db`
      SELECT id, default_ref, metadata
      FROM atlas.repositories
      WHERE name = ${options.repository};
    `) as RepositoryRow[]
    if (repositoryRows.length !== 1) errors.push(`expected one repository row, found ${repositoryRows.length}`)
    const repository = repositoryRows[0]
    if (!repository) throw new Error(errors[0])
    const metadata = parseMetadata(repository.metadata)
    const indexedCommit = typeof metadata.indexedCommit === 'string' ? metadata.indexedCommit : null

    const fileRows = (await db`
      SELECT
        fk.path,
        fv.repository_commit,
        fv.content_hash,
        NULLIF(fv.metadata->>'gitObjectId', '') AS git_object_id,
        count(DISTINCT fc.id)::bigint AS chunks,
        count(DISTINCT ce.chunk_id)::bigint AS embeddings,
        count(DISTINCT fc.id) FILTER (
          WHERE fc.metadata->>'chunkerVersion' IS DISTINCT FROM ${'atlas-chunker-v2'}
             OR fc.metadata->>'contentHash' IS DISTINCT FROM encode(digest(COALESCE(fc.content, ''), 'sha256'), 'hex')
        )::bigint AS chunk_metadata_mismatches,
        COALESCE(
          jsonb_agg(jsonb_build_array(fc.start_line, fc.end_line) ORDER BY fc.chunk_index)
            FILTER (WHERE fc.id IS NOT NULL),
          '[]'::jsonb
        ) AS ranges
      FROM atlas.file_keys fk
      LEFT JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
      LEFT JOIN atlas.file_chunks fc ON fc.file_version_id = fv.id
      LEFT JOIN atlas.chunk_embeddings ce
        ON ce.chunk_id = fc.id
       AND ce.model = ${process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL ?? 'qwen3-embedding-saigak:8b'}
       AND ce.dimension = ${1024}
      WHERE fk.repository_id = ${repository.id}
      GROUP BY fk.path, fv.repository_commit, fv.content_hash, fv.metadata
      ORDER BY fk.path;
    `) as IndexedFileRow[]

    const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]))
    const indexedByPath = new Map(fileRows.map((file) => [file.path, file]))
    const missingPaths = manifest.files.filter((file) => !indexedByPath.has(file.path)).map((file) => file.path)
    const stalePaths = fileRows.filter((file) => !expectedByPath.has(file.path)).map((file) => file.path)
    let hashMismatches = 0
    let objectMismatches = 0
    let commitMismatches = 0
    let uncoveredLines = 0
    let chunks = 0
    let embeddings = 0
    let chunkMetadataMismatches = 0

    for (const file of fileRows) {
      const expected = expectedByPath.get(file.path)
      if (!expected) continue
      const content = blobs.get(expected.objectId)
      if (!content) throw new Error(`missing Git blob ${expected.objectId} for ${file.path}`)
      if (file.content_hash !== createHash('sha256').update(content).digest('hex')) hashMismatches += 1
      if (file.git_object_id !== expected.objectId) objectMismatches += 1
      if (file.repository_commit !== gitHead) commitMismatches += 1
      chunks += count(file.chunks)
      embeddings += count(file.embeddings)
      chunkMetadataMismatches += count(file.chunk_metadata_mismatches)

      const lines = content.toString('utf8').split(/\r?\n/)
      const covered = new Uint8Array(lines.length)
      for (const [start, end] of ranges(file.ranges)) {
        for (let line = start; line <= Math.min(end, lines.length); line += 1) covered[line - 1] = 1
      }
      uncoveredLines += lines.filter((line, index) => line.trim().length > 0 && covered[index] === 0).length
    }

    const expectedModel = process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL ?? 'qwen3-embedding-saigak:8b'
    const metadataChecks: Array<[boolean, string]> = [
      [repository.default_ref === 'main', `default_ref is ${repository.default_ref}`],
      [metadata.indexStatus === 'ready', `indexStatus is ${String(metadata.indexStatus)}`],
      [indexedCommit === gitHead, `indexed commit ${indexedCommit ?? 'missing'} does not equal origin/main ${gitHead}`],
      [metadata.gitHead === gitHead, `stored gitHead ${String(metadata.gitHead)} does not equal ${gitHead}`],
      [metadata.treeHash === manifest.treeHash, 'stored treeHash does not match the eligible Git tree'],
      [metadata.embeddingModel === expectedModel, 'stored embedding model does not match runtime'],
      [metadata.embeddingDimension === 1024, 'stored embedding dimension is not 1024'],
      [count(metadata.expectedFiles) === manifest.files.length, 'stored expectedFiles is wrong'],
      [count(metadata.indexedFiles) === fileRows.length, 'stored indexedFiles is wrong'],
      [count(metadata.indexedChunks) === chunks, 'stored indexedChunks is wrong'],
      [count(metadata.embeddedChunks) === embeddings, 'stored embeddedChunks is wrong'],
    ]
    for (const [ok, message] of metadataChecks) if (!ok) errors.push(message)
    if (missingPaths.length) errors.push(`${missingPaths.length} missing paths`)
    if (stalePaths.length) errors.push(`${stalePaths.length} stale paths`)
    if (hashMismatches) errors.push(`${hashMismatches} file SHA-256 mismatches`)
    if (objectMismatches) errors.push(`${objectMismatches} Git object mismatches`)
    if (commitMismatches) errors.push(`${commitMismatches} file commit mismatches`)
    if (uncoveredLines) errors.push(`${uncoveredLines} uncovered nonblank lines`)
    if (chunks !== embeddings) errors.push(`${chunks - embeddings} chunks lack the configured embedding`)
    if (chunkMetadataMismatches) errors.push(`${chunkMetadataMismatches} chunks have invalid version/hash metadata`)
    for (const path of gold.absentPaths) {
      if (expectedByPath.has(path) || indexedByPath.has(path)) errors.push(`deleted path is present: ${path}`)
    }

    const schemaRows = (await db`
      SELECT
        format_type(a.atttypid, a.atttypmod) AS embedding_type,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas'
            AND indexname = 'atlas_chunk_embeddings_embedding_hnsw_idx'
            AND indexdef ILIKE '%USING hnsw%'
        ) AS has_hnsw,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas'
            AND indexname = 'atlas_file_versions_file_key_id_unique_idx'
            AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        ) AS has_current_file_unique,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas'
            AND indexname = 'atlas_file_keys_path_trgm_idx'
            AND indexdef ILIKE '%USING gin%gin_trgm_ops%'
        ) AS has_path_trgm,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas'
            AND indexname = 'atlas_file_chunks_content_trgm_idx'
            AND indexdef ILIKE '%USING gin%gin_trgm_ops%'
        ) AS has_content_trgm,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas'
            AND indexname = 'atlas_file_chunks_text_tsvector_gin_idx'
            AND indexdef ILIKE '%USING gin%'
        ) AS has_lexical_gin,
        (
          SELECT count(*)::int
          FROM pg_constraint
          WHERE connamespace = 'atlas'::regnamespace
            AND convalidated
            AND conname IN (
              'atlas_repositories_metadata_object_check',
              'atlas_file_versions_metadata_object_check',
              'atlas_file_chunks_metadata_object_check',
              'atlas_enrichments_metadata_object_check',
              'atlas_tree_sitter_facts_metadata_object_check',
              'atlas_github_events_payload_object_check'
            )
        ) AS json_object_constraints
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'atlas.chunk_embeddings'::regclass
        AND a.attname = 'embedding'
        AND NOT a.attisdropped;
    `) as Array<{
      embedding_type: string
      has_hnsw: boolean
      has_current_file_unique: boolean
      has_path_trgm: boolean
      has_content_trgm: boolean
      has_lexical_gin: boolean
      json_object_constraints: number
    }>
    const schema = schemaRows[0]
    if (schema?.embedding_type !== 'vector(1024)') errors.push(`chunk embedding column is ${schema?.embedding_type}`)
    if (!schema?.has_hnsw) errors.push('Atlas HNSW index is missing')
    if (!schema?.has_current_file_unique) errors.push('current-file unique index is missing')
    if (!schema?.has_path_trgm) errors.push('Atlas path trigram index is missing')
    if (!schema?.has_content_trgm) errors.push('Atlas content trigram index is missing')
    if (!schema?.has_lexical_gin) errors.push('Atlas lexical GIN index is missing')
    if (count(schema?.json_object_constraints) !== 6) {
      errors.push(`expected 6 validated Atlas JSON-object constraints, found ${count(schema?.json_object_constraints)}`)
    }

    const unfinishedRows = (await db`
      SELECT count(*)::bigint AS unfinished
      FROM atlas.github_events event
      WHERE event.processed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM atlas.ingestions ingestion
          WHERE ingestion.event_id = event.id
            AND ingestion.status NOT IN ('completed', 'failed', 'skipped')
        );
    `) as Array<{ unfinished: unknown }>
    const processedEventsWithUnfinishedIngestions = count(unfinishedRows[0]?.unfinished)
    if (processedEventsWithUnfinishedIngestions) {
      errors.push(`${processedEventsWithUnfinishedIngestions} processed events have unfinished ingestion`)
    }

    const returnedPaths = new Set<string>()
    const retrievalModes = new Set(['exact', 'lexical', 'semantic', 'hybrid'])
    const validateSearchPayload = (query: string, payload: CodeSearchResponse) => {
      if (payload.ok !== true) errors.push(`search response omitted ok=true for ${query}`)
      const items = payload.items ?? []
      const paths: string[] = []
      for (const item of items) {
        const path = item.path ?? ''
        if (path) {
          paths.push(path)
          returnedPaths.add(path)
        }
        const indexed = indexedByPath.get(path)
        if (!indexed) errors.push(`search returned a path outside the indexed manifest: ${path || 'unknown path'}`)
        if (item.repository !== options.repository) {
          errors.push(`search result used wrong repository for ${path || 'unknown path'}`)
        }
        if (item.ref !== options.ref) errors.push(`search result used wrong ref for ${path || 'unknown path'}`)
        if (item.commit !== gitHead) errors.push(`search result used wrong commit for ${path || 'unknown path'}`)
        if (
          !Number.isInteger(item.startLine) ||
          !Number.isInteger(item.endLine) ||
          (item.startLine ?? 0) < 1 ||
          (item.endLine ?? 0) < (item.startLine ?? 0)
        ) {
          errors.push(`search result used invalid line bounds for ${path || 'unknown path'}`)
        }
        if (item.contentHash !== indexed?.content_hash) {
          errors.push(`search result used wrong content hash for ${path || 'unknown path'}`)
        }
        if (!retrievalModes.has(item.retrievalMode ?? '')) {
          errors.push(`search result used invalid retrieval mode for ${path || 'unknown path'}`)
        }
        if (item.degradation !== null) errors.push(`search degraded for ${query}: ${String(item.degradation)}`)
      }
      if (payload.indexHealth?.status !== 'ok' || payload.indexHealth.indexedCommit !== gitHead) {
        errors.push(`search health disagreed with Git for ${query}`)
      }
      return paths
    }

    const goldResults: Array<{ query: string; paths: string[]; durationMs: number }> = []
    for (const fixture of gold.queries) {
      const result = await search(options.baseUrl, options.repository, options.ref, fixture.query)
      const paths = validateSearchPayload(fixture.query, result.payload)
      const matchingPath = fixture.expectedPaths.find((path) => paths.includes(path))
      if (!matchingPath) errors.push(`gold query missed top ten: ${fixture.query}`)
      if (fixture.expectedFirst && !fixture.expectedPaths.includes(paths[0] ?? '')) {
        errors.push(`exact gold query did not rank expected path first: ${fixture.query}`)
      }
      goldResults.push({ query: fixture.query, paths, durationMs: result.durationMs })
    }

    const deletedPathResults: Array<{ query: string; paths: string[]; durationMs: number }> = []
    for (const path of gold.absentPaths) {
      const result = await search(options.baseUrl, options.repository, options.ref, path)
      const paths = validateSearchPayload(path, result.payload)
      const absentPathError = absentPathSearchError(path, paths)
      if (absentPathError) errors.push(absentPathError)
      deletedPathResults.push({ query: path, paths, durationMs: result.durationMs })
    }

    const previewPaths = [...returnedPaths]
    for (const path of previewPaths) {
      const response = await fetch(
        `${options.baseUrl}/api/atlas/file?${new URLSearchParams({ repository: options.repository, ref: options.ref, path })}`,
      )
      const payload = (await response.json()) as {
        ok?: boolean
        repository?: string
        ref?: string
        commit?: string
        contentHash?: string
        path?: string
        error?: string
      }
      if (!response.ok || payload.ok !== true) errors.push(`source preview failed for ${path}: ${payload.error}`)
      if (payload.repository !== options.repository) errors.push(`source preview repository mismatch for ${path}`)
      if (payload.ref !== options.ref) errors.push(`source preview ref mismatch for ${path}`)
      if (payload.commit !== gitHead) errors.push(`source preview commit mismatch for ${path}`)
      if (payload.path !== path) errors.push(`source preview path mismatch for ${path}`)
      if (payload.contentHash !== indexedByPath.get(path)?.content_hash)
        errors.push(`source preview hash mismatch for ${path}`)
    }

    const performanceInputs = buildColdPerformanceQueries(gold.queries, options.performanceRuns)
    const performance = await runWithConcurrency(performanceInputs, options.concurrency, (query) =>
      search(options.baseUrl, options.repository, options.ref, query),
    )
    const latencies = performance.map((result) => result.durationMs)
    const p95Ms = percentile(latencies, 0.95)
    const p99Ms = percentile(latencies, 0.99)
    if (p95Ms >= 1_000) errors.push(`search p95 ${p95Ms.toFixed(1)}ms is not below 1000ms`)
    if (p99Ms >= 2_000) errors.push(`search p99 ${p99Ms.toFixed(1)}ms is not below 2000ms`)

    const cancellation = await runCancellationProbe({
      db,
      baseUrl: options.baseUrl,
      repository: options.repository,
      ref: options.ref,
      concurrency: options.concurrency,
    })
    if (!cancellation.reachedDatabase) errors.push('cancellation probe did not reach PostgreSQL')
    const lingeringCanceledQueries = cancellation.lingeringQueries
    if (lingeringCanceledQueries) errors.push(`${lingeringCanceledQueries} canceled Atlas queries remained active`)

    const report = {
      ok: errors.length === 0,
      verifiedAt: new Date().toISOString(),
      repository: options.repository,
      ref: options.ref,
      gitHead,
      indexedCommit,
      treeHash: manifest.treeHash,
      eligibilityVersion: manifest.eligibilityVersion,
      corpus: {
        expectedFiles: manifest.files.length,
        indexedFiles: fileRows.length,
        missingPaths: missingPaths.length,
        stalePaths: stalePaths.length,
        hashMismatches,
        objectMismatches,
        commitMismatches,
        uncoveredLines,
        chunks,
        embeddings,
        chunksWithoutEmbedding: chunks - embeddings,
        chunkMetadataMismatches,
      },
      schema,
      processedEventsWithUnfinishedIngestions,
      goldSet: { version: gold.version, queries: goldResults },
      deletedPaths: deletedPathResults,
      sourcePreviews: { paths: previewPaths.length },
      performance: {
        requests: latencies.length,
        concurrency: options.concurrency,
        queryEmbeddingCache: 'cold-unique-query',
        p95Ms,
        p99Ms,
      },
      cancellation: {
        reachedDatabase: cancellation.reachedDatabase,
        observedBlockedQueries: cancellation.observedBlockedQueries,
        lingeringQueries: cancellation.lingeringQueries,
      },
      lingeringCanceledQueries,
      errors,
    }
    if (!options.json || errors.length > 0) console.log(JSON.stringify(report, null, 2))
    else process.stdout.write(`${JSON.stringify(report)}\n`)
    if (errors.length > 0) process.exitCode = 1
  } finally {
    await db.close()
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Atlas verification failed', error))
}
