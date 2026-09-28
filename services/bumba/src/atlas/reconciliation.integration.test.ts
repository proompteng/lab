import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'

import { runWithActivityContext, type ActivityContext } from '@proompteng/temporal-bun-sdk/worker'

import activities, { __test__ as activityTest } from '../activities/index'
import { __test__ as eventConsumerTest } from '../event-consumer'
import { LEGACY_RECONCILE_PENDING_ERROR } from './ingestion-status'

const databaseUrl = process.env.ATLAS_INTEGRATION_DATABASE_URL?.trim()
if (process.env.ATLAS_REQUIRE_INTEGRATION_TESTS === '1' && !databaseUrl) {
  throw new Error('ATLAS_INTEGRATION_DATABASE_URL is required when ATLAS_REQUIRE_INTEGRATION_TESTS=1')
}

const integrationTest = databaseUrl ? test : test.skip
const envKeys = [
  'DATABASE_URL',
  'PGSSLMODE',
  'OPENAI_API_BASE_URL',
  'OPENAI_EMBEDDING_API_BASE_URL',
  'OPENAI_EMBEDDING_MODEL',
  'OPENAI_EMBEDDING_DIMENSION',
  'ATLAS_CODE_SEARCH_EMBEDDING_MODEL',
  'ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION',
  'OPENAI_EMBEDDING_BATCH_SIZE',
  'OPENAI_EMBEDDING_BATCH_MAX_CHARS',
  'OPENAI_EMBEDDING_MAX_ATTEMPTS',
  'BUMBA_ATLAS_PREPARE_CONCURRENCY',
] as const
const envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]))
let root = ''
let origin = ''
let checkout = ''
let db: SQL | null = null
let embeddingServer: ReturnType<typeof Bun.serve> | null = null
let embeddingRequestCount = 0
let failEmbeddingAfterRequest: number | null = null

const git = async (cwd: string, args: string[]) => {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

const commitAndPush = async (message: string) => {
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', message])
  await git(checkout, ['push', 'origin', 'HEAD:main'])
  return await git(checkout, ['rev-parse', 'HEAD'])
}

beforeAll(async () => {
  if (!databaseUrl) return
  root = await mkdtemp(join(tmpdir(), 'atlas-reconciliation-'))
  origin = join(root, 'origin.git')
  checkout = join(root, 'checkout')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '--initial-branch=main'])
  await git(root, ['clone', origin, checkout])
  await git(checkout, ['config', 'user.email', 'atlas-test@proompteng.ai'])
  await git(checkout, ['config', 'user.name', 'Atlas Test'])
  await git(checkout, ['config', 'commit.gpgsign', 'false'])
  await git(checkout, ['config', 'tag.gpgsign', 'false'])

  embeddingServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      embeddingRequestCount += 1
      if (failEmbeddingAfterRequest !== null && embeddingRequestCount > failEmbeddingAfterRequest) {
        return Response.json({ error: 'intentional streaming-recovery failure' }, { status: 503 })
      }
      const body = (await request.json()) as { input?: string | string[] }
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? '']
      return Response.json({
        data: inputs.map((input, index) => ({
          index,
          embedding: Array.from({ length: 1024 }, (_, dimension) =>
            dimension === createHash('sha256').update(input).digest()[0] ? 1 : 0,
          ),
        })),
      })
    },
  })

  process.env.DATABASE_URL = databaseUrl
  process.env.PGSSLMODE = 'disable'
  process.env.OPENAI_API_BASE_URL = `http://127.0.0.1:${embeddingServer.port}/v1`
  process.env.OPENAI_EMBEDDING_API_BASE_URL = `http://127.0.0.1:${embeddingServer.port}/v1`
  process.env.OPENAI_EMBEDDING_MODEL = 'global-test-model'
  process.env.OPENAI_EMBEDDING_DIMENSION = '4096'
  process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL = 'atlas-test-model'
  process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION = '1024'
  process.env.OPENAI_EMBEDDING_BATCH_SIZE = '32'
  process.env.OPENAI_EMBEDDING_BATCH_MAX_CHARS = '1000000'
  process.env.OPENAI_EMBEDDING_MAX_ATTEMPTS = '1'
  process.env.BUMBA_ATLAS_PREPARE_CONCURRENCY = '2'

  db = new SQL(databaseUrl)
  await db`DROP SCHEMA IF EXISTS atlas CASCADE;`
  await db`CREATE SCHEMA atlas;`
  await db`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;`
  await db`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;`
  await db`
    CREATE TABLE atlas.repositories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      default_ref text NOT NULL DEFAULT 'main',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `
  await db`
    CREATE TABLE atlas.file_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
      path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, path)
    );
  `
  await db`
    CREATE TABLE atlas.file_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_key_id uuid NOT NULL UNIQUE REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
      repository_ref text NOT NULL DEFAULT 'main',
      repository_commit text,
      content_hash text NOT NULL,
      language text,
      byte_size int,
      line_count int,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_timestamp timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `
  await db`
    CREATE TABLE atlas.file_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_version_id uuid NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      chunk_index int NOT NULL,
      start_line int,
      end_line int,
      content text,
      token_count int,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      text_tsvector tsvector,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (file_version_id, chunk_index)
    );
  `
  await db`
    CREATE TABLE atlas.chunk_embeddings (
      chunk_id uuid PRIMARY KEY REFERENCES atlas.file_chunks(id) ON DELETE CASCADE,
      model text NOT NULL,
      dimension int NOT NULL,
      embedding vector(1024) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `
  await db`
    CREATE TABLE atlas.github_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id text NOT NULL UNIQUE
    );
  `
  await db`
    CREATE TABLE atlas.ingestions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
      workflow_id text NOT NULL,
      status text NOT NULL,
      error text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      UNIQUE (event_id, workflow_id)
    );
  `
})

afterAll(async () => {
  if (databaseUrl) await activityTest.resetAtlasDb()
  if (db) await db.close()
  await embeddingServer?.stop(true)
  if (root) await rm(root, { recursive: true, force: true })
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

integrationTest('legacy ingestion correction and aging preserve real failures', async () => {
  if (!db) throw new Error('integration database was not initialized')
  const workflowId = 'bumba-atlas-reconcile-proompteng-lab-legacy'
  const eventRows = (await db`
    INSERT INTO atlas.github_events (delivery_id)
    VALUES
      ('legacy-pending-delivery'),
      ('real-failure-delivery'),
      ('legacy-real-failure-delivery'),
      ('stale-legacy-delivery')
    RETURNING id, delivery_id;
  `) as Array<{ id: string; delivery_id: string }>
  const legacyEventId = eventRows.find((row) => row.delivery_id === 'legacy-pending-delivery')?.id
  const realFailureEventId = eventRows.find((row) => row.delivery_id === 'real-failure-delivery')?.id
  const legacyRealFailureEventId = eventRows.find((row) => row.delivery_id === 'legacy-real-failure-delivery')?.id
  const staleLegacyEventId = eventRows.find((row) => row.delivery_id === 'stale-legacy-delivery')?.id
  if (!legacyEventId || !realFailureEventId || !legacyRealFailureEventId || !staleLegacyEventId) {
    throw new Error('integration events were not created')
  }

  await activities.upsertIngestion({
    deliveryId: 'legacy-pending-delivery',
    workflowId,
    status: 'failed',
    error: LEGACY_RECONCILE_PENDING_ERROR,
  })
  await activities.upsertIngestion({
    deliveryId: 'legacy-pending-delivery',
    workflowId,
    status: 'completed',
  })

  const preservedRows = (await db`
    SELECT status, error
    FROM atlas.ingestions
    WHERE workflow_id = ${workflowId};
  `) as Array<{ status: string; error: string | null }>
  expect(preservedRows[0]).toEqual({ status: 'failed', error: LEGACY_RECONCILE_PENDING_ERROR })
  await expect(eventConsumerTest.getIngestionCounts(db as never, legacyEventId)).resolves.toMatchObject({
    total: 1,
    terminal: 0,
    failed: 0,
    nonterminal: 1,
  })

  await activities.upsertIngestion({
    deliveryId: 'legacy-pending-delivery',
    workflowId,
    status: 'completed',
    correctLegacyPendingFailure: true,
  })

  const correctedRows = (await db`
    SELECT status, error
    FROM atlas.ingestions
    WHERE workflow_id = ${workflowId};
  `) as Array<{ status: string; error: string | null }>
  expect(correctedRows[0]).toEqual({ status: 'completed', error: null })
  await expect(eventConsumerTest.getIngestionCounts(db as never, legacyEventId)).resolves.toMatchObject({
    total: 1,
    terminal: 1,
    failed: 0,
    nonterminal: 0,
  })

  await activities.upsertIngestion({
    deliveryId: 'real-failure-delivery',
    workflowId,
    status: 'failed',
    error: 'real reconciliation failure',
  })
  await expect(
    activities.upsertIngestion({
      deliveryId: 'real-failure-delivery',
      workflowId,
      status: 'completed',
      correctLegacyPendingFailure: true,
    }),
  ).rejects.toThrow('does not match the legacy pending-failure correction guard')

  const realFailureRows = (await db`
    SELECT status, error
    FROM atlas.ingestions i
    JOIN atlas.github_events e ON e.id = i.event_id
    WHERE e.delivery_id = 'real-failure-delivery';
  `) as Array<{ status: string; error: string | null }>
  expect(realFailureRows[0]).toEqual({ status: 'failed', error: 'real reconciliation failure' })
  await expect(eventConsumerTest.getIngestionCounts(db as never, realFailureEventId)).resolves.toMatchObject({
    total: 1,
    terminal: 1,
    failed: 1,
    nonterminal: 0,
  })

  await activities.upsertIngestion({
    deliveryId: 'legacy-real-failure-delivery',
    workflowId,
    status: 'failed',
    error: LEGACY_RECONCILE_PENDING_ERROR,
  })
  await activities.upsertIngestion({
    deliveryId: 'legacy-real-failure-delivery',
    workflowId,
    status: 'failed',
    error: 'real reconciliation failure after pending',
    correctLegacyPendingFailure: true,
  })
  await expect(eventConsumerTest.getIngestionCounts(db as never, legacyRealFailureEventId)).resolves.toMatchObject({
    total: 1,
    terminal: 1,
    failed: 1,
    nonterminal: 0,
  })

  const staleStartedAt = new Date(Date.now() - 60_000).toISOString()
  await activities.upsertIngestion({
    deliveryId: 'stale-legacy-delivery',
    workflowId,
    status: 'failed',
    error: LEGACY_RECONCILE_PENDING_ERROR,
    startedAt: staleStartedAt,
  })
  await expect(eventConsumerTest.markStaleIngestionsFailed(db as never, staleLegacyEventId, 1_000)).resolves.toBe(1)
  await expect(eventConsumerTest.getIngestionCounts(db as never, staleLegacyEventId)).resolves.toMatchObject({
    total: 1,
    terminal: 1,
    failed: 1,
    nonterminal: 0,
  })
  const staleRows = (await db`
    SELECT error
    FROM atlas.ingestions i
    JOIN atlas.github_events e ON e.id = i.event_id
    WHERE e.delivery_id = 'stale-legacy-delivery';
  `) as Array<{ error: string | null }>
  expect(staleRows[0]?.error).toContain('stale nonterminal ingestion auto-failed by bumba event-consumer')
})

integrationTest(
  'reconciliation converges additions, modifications, deletion, rename, duplicate, and stale events',
  async () => {
    if (!db) throw new Error('integration database was not initialized')
    await mkdir(join(checkout, 'src'), { recursive: true })
    await mkdir(join(checkout, '.github', 'ISSUE_TEMPLATE'), { recursive: true })
    await writeFile(
      join(checkout, 'src', 'atlas.ts'),
      [
        'export const createAtlasCodeSearchHandlers = () => ({ ready: true })',
        '',
        'export function unchanged() {',
        "  return 'same'",
        '}',
        '',
      ].join('\n'),
    )
    await writeFile(join(checkout, 'README.md'), '# Atlas\n\nComplete Git corpus.\n')
    await writeFile(join(checkout, 'deleted.ts'), 'export const deletedFixture = true\n')
    await writeFile(join(checkout, '.github', 'actionlint.yaml'), 'self-hosted-runner:\n  labels: [arc]\n')
    await writeFile(join(checkout, '.github', 'ISSUE_TEMPLATE', 'codex-task.md'), '# Codex task\n')
    await writeFile(join(checkout, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const firstCommit = await commitAndPush('initial')

    const initial = await activities.reconcileAtlasRepository({
      repoRoot: checkout,
      repository: 'proompteng/lab',
      ref: 'main',
      commit: firstCommit,
    })
    expect(initial).toMatchObject({ expectedFiles: 5, indexedFiles: 5, embeddings: initial.chunks })

    const firstRows = (await db`
    SELECT fk.path, fv.id, fv.content_hash, fv.repository_commit,
           jsonb_typeof(fv.metadata) AS metadata_type,
           count(fc.id)::int AS chunks,
           count(ce.chunk_id)::int AS embeddings
    FROM atlas.file_keys fk
    JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
    LEFT JOIN atlas.file_chunks fc ON fc.file_version_id = fv.id
    LEFT JOIN atlas.chunk_embeddings ce ON ce.chunk_id = fc.id
    GROUP BY fk.path, fv.id
    ORDER BY fk.path;
  `) as Array<{
      path: string
      id: string
      content_hash: string
      repository_commit: string
      metadata_type: string
      chunks: number
      embeddings: number
    }>
    expect(firstRows.map((row) => row.path)).toHaveLength(5)
    expect(firstRows.map((row) => row.path)).toEqual(
      expect.arrayContaining([
        '.github/ISSUE_TEMPLATE/codex-task.md',
        '.github/actionlint.yaml',
        'README.md',
        'deleted.ts',
        'src/atlas.ts',
      ]),
    )
    expect(firstRows.every((row) => row.metadata_type === 'object' && row.chunks === row.embeddings)).toBe(true)
    const oldAtlasVersion = firstRows.find((row) => row.path === 'src/atlas.ts')?.id

    await writeFile(
      join(checkout, 'src', 'atlas.ts'),
      "export const createAtlasCodeSearchHandlers = () => ({ ready: 'changed' })\n",
    )
    await rm(join(checkout, 'deleted.ts'))
    await rename(join(checkout, 'README.md'), join(checkout, 'ATLAS.md'))
    const secondCommit = await commitAndPush('modify delete rename')

    const changed = await activities.reconcileAtlasRepository({
      repoRoot: checkout,
      repository: 'proompteng/lab',
      ref: 'main',
      commit: firstCommit,
    })
    expect(changed.commit).toBe(secondCommit)
    expect(changed).toMatchObject({ expectedFiles: 4, indexedFiles: 4, deletedFiles: 2 })

    const replay = await activities.reconcileAtlasRepository({
      repoRoot: checkout,
      repository: 'proompteng/lab',
      ref: 'main',
      commit: secondCommit,
    })
    expect(replay).toMatchObject({ commit: secondCommit, changedFiles: 0, unchangedFiles: 4 })

    const finalRows = (await db`
    SELECT fk.path, fv.id, fv.repository_commit, fv.content_hash,
           fv.metadata->>'gitObjectId' AS object_id,
           count(fc.id)::int AS chunks,
           count(ce.chunk_id)::int AS embeddings
    FROM atlas.file_keys fk
    JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
    LEFT JOIN atlas.file_chunks fc ON fc.file_version_id = fv.id
    LEFT JOIN atlas.chunk_embeddings ce ON ce.chunk_id = fc.id
    GROUP BY fk.path, fv.id
    ORDER BY fk.path;
  `) as Array<{
      path: string
      id: string
      repository_commit: string
      content_hash: string
      object_id: string
      chunks: number
      embeddings: number
    }>
    expect(finalRows.map((row) => row.path)).toHaveLength(4)
    expect(finalRows.map((row) => row.path)).toEqual(
      expect.arrayContaining([
        '.github/ISSUE_TEMPLATE/codex-task.md',
        '.github/actionlint.yaml',
        'ATLAS.md',
        'src/atlas.ts',
      ]),
    )
    expect(finalRows.every((row) => row.repository_commit === secondCommit && row.chunks === row.embeddings)).toBe(true)
    expect(finalRows.find((row) => row.path === 'src/atlas.ts')?.id).not.toBe(oldAtlasVersion)
    const oldVersionRows = (await db`
      SELECT count(*)::int AS count
      FROM atlas.file_versions
      WHERE id = ${oldAtlasVersion ?? null};
    `) as Array<{ count: number }>
    expect(oldVersionRows[0]?.count).toBe(0)

    const coverage = (await db`
    SELECT fc.start_line, fc.end_line, fc.content, fc.metadata
    FROM atlas.file_chunks fc
    JOIN atlas.file_versions fv ON fv.id = fc.file_version_id
    JOIN atlas.file_keys fk ON fk.id = fv.file_key_id
    WHERE fk.path = 'src/atlas.ts'
    ORDER BY fc.chunk_index;
  `) as Array<{ start_line: number; end_line: number; content: string; metadata: Record<string, unknown> }>
    expect(coverage.some((chunk) => chunk.content.includes('createAtlasCodeSearchHandlers'))).toBe(true)
    expect(
      coverage.every(
        (chunk) =>
          chunk.metadata.chunkerVersion === 'atlas-chunker-v2' &&
          chunk.metadata.contentHash === createHash('sha256').update(chunk.content).digest('hex'),
      ),
    ).toBe(true)

    const repositoryRows = (await db`
    SELECT default_ref, metadata, jsonb_typeof(metadata) AS metadata_type
    FROM atlas.repositories
    WHERE name = 'proompteng/lab';
  `) as Array<{ default_ref: string; metadata: Record<string, unknown>; metadata_type: string }>
    expect(repositoryRows[0]).toMatchObject({
      default_ref: 'main',
      metadata_type: 'object',
      metadata: {
        indexStatus: 'ready',
        indexedCommit: secondCommit,
        expectedFiles: 4,
        indexedFiles: 4,
        embeddingDimension: 1024,
        missingPaths: 0,
        stalePaths: 0,
        hashMismatches: 0,
        uncoveredLines: 0,
      },
    })

    await expect(
      Promise.resolve().then(() =>
        activities.reconcileAtlasRepository({
          repoRoot: checkout,
          repository: 'proompteng/lab',
          ref: 'feature',
          commit: secondCommit,
        }),
      ),
    ).rejects.toThrow(/only main/)
  },
  120_000,
)

integrationTest(
  'reconciliation persists bounded batches and resumes after an embedding failure',
  async () => {
    if (!db) throw new Error('integration database was not initialized')
    await mkdir(join(checkout, 'recovery'), { recursive: true })
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(checkout, 'recovery', `${index}.ts`), `export const recovery${index} = ${index}\n`)
    }
    const commit = await commitAndPush('streaming recovery fixture')
    let lastHeartbeatDetails: unknown[] = []
    const activityContext = (heartbeatDetails: unknown[]): ActivityContext =>
      ({
        info: { lastHeartbeatDetails: heartbeatDetails },
        cancellationSignal: new AbortController().signal,
        isCancellationRequested: false,
        heartbeat: async (...details: unknown[]) => {
          lastHeartbeatDetails = details
        },
        throwIfCancelled: () => undefined,
      }) as ActivityContext

    failEmbeddingAfterRequest = embeddingRequestCount + 2
    await expect(
      runWithActivityContext(activityContext([]), () =>
        activities.reconcileAtlasRepository({
          repoRoot: checkout,
          repository: 'proompteng/recovery',
          ref: 'main',
          commit,
        }),
      ),
    ).rejects.toThrow(/embedding request failed/i)

    const failedRows = (await db`
      SELECT
        r.metadata->>'indexStatus' AS status,
        (r.metadata->>'expectedFiles')::int AS expected_files,
        count(fv.id)::int AS indexed_files
      FROM atlas.repositories r
      LEFT JOIN atlas.file_keys fk ON fk.repository_id = r.id
      LEFT JOIN atlas.file_versions fv ON fv.file_key_id = fk.id
      WHERE r.name = 'proompteng/recovery'
      GROUP BY r.id;
    `) as Array<{ status: string; expected_files: number; indexed_files: number }>
    expect(failedRows[0]?.status).toBe('failed')
    expect(failedRows[0]?.indexed_files).toBeGreaterThan(0)
    expect(failedRows[0]?.indexed_files).toBeLessThan(failedRows[0]?.expected_files ?? 0)
    expect(lastHeartbeatDetails[0]).toMatchObject({
      commit,
      preparedFiles: failedRows[0]?.indexed_files,
      changedFiles: failedRows[0]?.expected_files,
    })

    await writeFile(join(checkout, 'recovery', 'advanced-main.ts'), 'export const advancedMain = true\n')
    const advancedCommit = await commitAndPush('advance main while reconciliation retries')
    expect(advancedCommit).not.toBe(commit)

    failEmbeddingAfterRequest = null
    const recovered = await runWithActivityContext(activityContext(lastHeartbeatDetails), () =>
      activities.reconcileAtlasRepository({
        repoRoot: checkout,
        repository: 'proompteng/recovery',
        ref: 'main',
        commit,
      }),
    )
    expect(recovered).toMatchObject({
      repository: 'proompteng/recovery',
      commit,
      expectedFiles: failedRows[0]?.expected_files,
      indexedFiles: failedRows[0]?.expected_files,
      changedFiles: failedRows[0]?.expected_files,
      unchangedFiles: 0,
    })

    const readyRows = (await db`
      SELECT metadata->>'indexStatus' AS status, metadata->>'indexedCommit' AS indexed_commit
      FROM atlas.repositories
      WHERE name = 'proompteng/recovery';
    `) as Array<{ status: string; indexed_commit: string }>
    expect(readyRows[0]).toEqual({ status: 'ready', indexed_commit: commit })
  },
  120_000,
)
