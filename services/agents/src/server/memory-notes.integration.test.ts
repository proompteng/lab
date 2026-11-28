import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { asRecord } from '@proompteng/agent-contracts'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  AgentsShellRunner,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  type AuthContext,
} from './agents-shell-mcp'
import type { AgentsDatabase } from './db'
import { createPostgresMemoriesStore } from './memory-notes-store'
import * as initial from './migrations/20260521_agents_memory_notes'
import * as retirement from './migrations/20261111_agents_memory_note_retirement'
import * as saveKeys from './migrations/20261112_agents_memory_save_keys'
import {
  getMemoryNoteHandler,
  getMemoryNotesHandler,
  postMemoryNotesHandler,
  postRetireMemoryNoteHandler,
} from './v1/memory-notes'
import { postRepoContextHandler } from './v1/repo-context'

vi.mock('./kysely-migrations', () => ({ ensureMigrations: async () => undefined }))

const url = process.env.AGENTS_STORE_TEST_DATABASE_URL
describe.skipIf(!url)('Memory notes on PostgreSQL through API, CLI and MCP', () => {
  const databaseName = `memory_test_${crypto.randomUUID().replaceAll('-', '')}`
  let root: string
  const previous = { dimension: process.env.OPENAI_EMBEDDING_DIMENSION, baseUrl: process.env.AGENTS_SERVICE_BASE_URL }
  let admin: Pool
  let db: Kysely<AgentsDatabase>
  let store: ReturnType<typeof createPostgresMemoriesStore>
  let api: ReturnType<typeof createServer>
  let baseUrl: string

  beforeAll(async () => {
    if (!url) throw new Error('AGENTS_STORE_TEST_DATABASE_URL is required')
    root = mkdtempSync(join(tmpdir(), 'memory-shell-test-'))
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    admin = new Pool({ connectionString: url })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const testUrl = new URL(url)
    testUrl.pathname = `/${databaseName}`
    db = new Kysely<AgentsDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: testUrl.toString() }) }),
    })
    await sql`CREATE EXTENSION vector`.execute(db)
    await sql`CREATE EXTENSION pgcrypto`.execute(db)
    await initial.up(db)
    await retirement.up(db)
    for (const [id, date] of [
      ['11111111-1111-4111-8111-111111111111', '2026-01-01'],
      ['22222222-2222-4222-8222-222222222222', '2026-01-02'],
    ]) {
      await sql`INSERT INTO memories.entries (id, task_name, content, summary, tags, metadata, source, embedding, encoder_model, created_at)
        VALUES (${id}::uuid, 'legacy-keep', 'Legacy content remains unchanged.', 'Legacy summary', ARRAY['b','a'],
        '{"repository":"proompteng/lab","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,
        'agents.memory-notes', '[0,1,0]'::vector, 'test', ${date}::timestamptz)`.execute(db)
    }
    await saveKeys.up(db)
    store = createPostgresMemoriesStore({
      url: testUrl.toString(),
      createDb: () => db,
      embedText: async (text) => {
        if (!text.includes('\n\n')) return text.includes('kitchen') ? [-1, 0, 0] : [1, 0, 0]
        return text.includes('MCTS') ? [0.676, Math.sqrt(1 - 0.676 ** 2), 0] : [0.61, 0, Math.sqrt(1 - 0.61 ** 2)]
      },
    })
    const deps = { storeFactory: () => ({ ...store, close: async () => undefined }) }
    api = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const req = new Request(`${baseUrl}${request.url}`, {
          method: request.method,
          ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        })
        const result =
          request.url === '/v1/context'
            ? await postRepoContextHandler(req, {
                ...deps,
                fetch: async () =>
                  Response.json({
                    ok: true,
                    indexHealth: { status: 'ok', indexedCommit: 'a'.repeat(40) },
                    items: [
                      {
                        repository: 'proompteng/lab',
                        ref: 'main',
                        commit: 'a'.repeat(40),
                        path: 'services/agents/src/server/memory-notes-store.ts',
                        startLine: 1,
                        endLine: 10,
                        contentHash: 'b'.repeat(64),
                        snippet: 'MCTS candidate context source code.',
                      },
                    ],
                  }),
              })
            : request.method === 'GET' && /^\/v1\/memory-notes\/[^/?]+$/.test(request.url ?? '')
              ? await getMemoryNoteHandler(req, new URL(req.url).pathname.split('/').at(-1) ?? '', deps)
              : request.url?.startsWith('/v1/memory-notes/retire')
                ? await postRetireMemoryNoteHandler(req, deps)
                : request.method === 'POST'
                  ? await postMemoryNotesHandler(req, deps)
                  : await getMemoryNotesHandler(req, deps)
        response.writeHead(result.status, { 'content-type': 'application/json' })
        response.end(await result.text())
      } catch (error) {
        response.writeHead(500)
        response.end(String(error))
      }
    }).listen(0, '127.0.0.1')
    await once(api, 'listening')
    const address = api.address()
    if (!address || typeof address === 'string') throw new Error('Missing test API port')
    baseUrl = `http://127.0.0.1:${address.port}`
    process.env.AGENTS_SERVICE_BASE_URL = baseUrl
  })

  afterAll(async () => {
    await new Promise<void>((done) => api?.close(() => done()) ?? done())
    await store?.close()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
    for (const [key, value] of [
      ['OPENAI_EMBEDDING_DIMENSION', previous.dimension],
      ['AGENTS_SERVICE_BASE_URL', previous.baseUrl],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  const seed = (content: string, repository = 'proompteng/lab') =>
    store.persist({
      namespace: 'memory-evaluation',
      summary: content,
      content,
      tags: ['bayn'],
      metadata: { repository, noteModel: 'test-model', commit: 'test-commit' },
    })

  it('returns useful matches, empty negatives, and latest scoped notes through the Bun CLI', async () => {
    const correct = await seed(
      'MCTS nodes bind candidate expressions, metrics and evaluation references to one design.',
    )
    await seed('Synthesis mobile detail AgentRun submission succeeded.')
    await seed('MCTS changes in a different repository.', 'other/repo')
    const command = resolve('..', 'memories', 'retrieve.ts')
    const run = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)('bun', [command, ...args, '--json'], {
        env: { ...process.env, MEMORIES_AGENTS_URL: baseUrl },
      })
      return JSON.parse(stdout)
    }
    const search = await run(
      '--query',
      'MCTS selected expression wrong metrics multiple designs candidate evidence',
      '--repository',
      'proompteng/lab',
    )
    expect(search.memories.map((row: { id: string }) => row.id)).toEqual([correct.id])
    expect((await run('--query', 'kitchen faucet dishwasher filter replacement')).memories).toEqual([])
    const latest = await run(
      '--latest',
      '--repository',
      'proompteng/lab',
      '--tags',
      'bayn',
      '--model',
      'test-model',
      '--after',
      '2026-01-01',
      '--before',
      '2027-01-01',
      '--limit',
      '1',
    )
    expect(latest.memories).toHaveLength(1)
    expect(latest.memories[0].summary).toContain('Synthesis')
    await expect(run('--latest', '--after', 'not-a-date')).rejects.toThrow()
  })

  it('retrieves code and notes with a bounded JSON CLI response and withholds stale code', async () => {
    const command = resolve('..', 'memories', 'context.ts')
    const run = async (expectedCommit: string) => {
      const { stdout } = await promisify(execFile)(
        'bun',
        [
          command,
          '--query',
          'MCTS candidate metrics',
          '--expected-commit',
          expectedCommit,
          '--max-bytes',
          '4096',
          '--json',
        ],
        { env: { ...process.env, MEMORIES_AGENTS_URL: baseUrl } },
      )
      expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(4097)
      return JSON.parse(stdout)
    }
    const current = await run('a'.repeat(40))
    expect(current.snapshotVerified).toBe(true)
    expect(current.code).toMatchObject({
      state: 'ready',
      items: [expect.objectContaining({ path: 'services/agents/src/server/memory-notes-store.ts' })],
    })
    expect(current.memory.state).toBe('ready')
    expect(current.memory.items.length).toBeGreaterThan(0)
    const stale = await run('d'.repeat(40))
    expect(stale.snapshotVerified).toBe(false)
    expect(stale.code).toMatchObject({ state: 'stale', items: [] })
    expect(stale.memory.state).toBe('ready')
  })

  it('backfills replay keys while preserving historical duplicate rows', async () => {
    const first = await store.persist({
      namespace: 'legacy-keep',
      content: 'Legacy content remains unchanged.',
      summary: 'Legacy summary',
      tags: ['a', 'b'],
      metadata: { commit: 'a'.repeat(40), repository: 'proompteng/lab' },
    })
    expect(first.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(await store.count({ namespace: 'legacy-keep' })).toBe(2)
    expect((await store.get('22222222-2222-4222-8222-222222222222'))?.content).toBe(first.content)
  })

  it('saves, retries, lists and opens an exact note through the Bun CLI', async () => {
    const run = async (script: 'save' | 'retrieve', ...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        'bun',
        [resolve('..', 'memories', `${script}.ts`), ...args, '--json'],
        {
          env: { ...process.env, MEMORIES_AGENTS_URL: baseUrl },
        },
      )
      return JSON.parse(stdout)
    }
    const args = [
      '--task-name',
      'cli-workflow',
      '--repository',
      'proompteng/lab',
      '--commit',
      'a'.repeat(40),
      '--content',
      'Durable CLI evidence.',
      '--summary',
      'CLI replay evidence',
    ]
    const first = await run('save', ...args)
    expect(await run('save', ...args)).toEqual(first)
    const read = await run('retrieve', '--id', first.memory.id)
    expect(read.content).toBe('Durable CLI evidence.')
    expect(read.memory).toMatchObject({ repository: 'proompteng/lab', commit: 'a'.repeat(40) })
    const page = await run('retrieve', '--latest', '--task-name', 'cli-workflow')
    expect(page).toMatchObject({ memories: [{ id: first.memory.id }], nextCursor: null })
    expect(page.memories[0]).not.toHaveProperty('content')
    await expect(run('save', ...args, '--metadata', '{}')).rejects.toThrow('unsupported flag --metadata')
    await expect(run('retrieve', '--id', '00000000-0000-4000-8000-000000000000')).rejects.toThrow('404')
  })

  it('deduplicates concurrent saves, metadata key order and tag order without resurrecting retired notes', async () => {
    const input = {
      namespace: 'retry-test',
      content: 'Durable retry evidence.',
      tags: ['b', 'a'],
      metadata: { repository: 'proompteng/lab', commit: 'a'.repeat(40) },
    }
    const [first, retry] = await Promise.all([
      store.persist(input),
      store.persist({
        ...input,
        tags: ['a', 'b', 'a'],
        metadata: { commit: 'a'.repeat(40), repository: 'proompteng/lab' },
      }),
    ])
    expect(first).toEqual(retry)
    expect(await store.count({ namespace: 'retry-test' })).toBe(1)
    const retired = await store.retire({ id: first.id, reason: 'Replaced by verified evidence.' })
    expect(await store.persist(input)).toEqual(retired)
    expect(await store.count({ namespace: 'retry-test' })).toBe(1)
  })

  it('pages without losing tied or sub-millisecond timestamps, even when the cursor note is retired', async () => {
    for (let index = 0; index < 5; index++) {
      const note = await store.persist({
        namespace: 'paging-test',
        content: `Page note ${index}`,
        metadata: { repository: 'proompteng/lab' },
      })
      await sql`UPDATE memories.entries SET created_at = ${`2026-11-11T12:00:00.12345${Math.floor(index / 2)}Z`}::timestamptz WHERE id = ${note.id}::uuid`.execute(
        db,
      )
    }
    const expected = await db
      .selectFrom('memories.entries')
      .select('id')
      .where('task_name', '=', 'paging-test')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.list({ namespace: 'paging-test', limit: 1, cursor })
      expect(page.memories).toHaveLength(1)
      const note = page.memories[0]
      if (!note) throw new Error('Missing page note')
      expect(note).not.toHaveProperty('content')
      expect(note).not.toHaveProperty('metadata')
      seen.push(note.id)
      if (seen.length === 1) await store.retire({ id: note.id, reason: 'Cursor stability check.' })
      cursor = page.nextCursor ?? undefined
      expect(seen.length).toBeLessThanOrEqual(5)
    } while (cursor)
    expect(seen).toEqual(expected.map((row) => row.id))
    await expect(store.list({ cursor: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(
      'cursor note not found',
    )
  })

  it('retires atomically, preserves history and rejects incompatible retries and replacements', async () => {
    const old = await seed('MCTS old instruction to retire.')
    const replacement = await seed('MCTS corrected instruction.')
    const other = await seed('MCTS unrelated repository.', 'other/repo')
    await expect(store.retire({ id: old.id, reason: 'wrong repository', replacementId: other.id })).rejects.toThrow(
      'same repository',
    )
    const input = { id: old.id, reason: 'Superseded by verified source.', replacementId: replacement.id }
    const [first, retry] = await Promise.all([store.retire(input), store.retire(input)])
    expect(first).toEqual(retry)
    expect(first).toMatchObject({ retirementReason: input.reason, replacementId: replacement.id, content: old.content })
    expect(first.retiredAt).toBeTruthy()
    expect(
      await store.retire({ ...input, id: old.id.toUpperCase(), replacementId: replacement.id.toUpperCase() }),
    ).toEqual(first)
    expect(
      (await store.retrieve({ query: 'MCTS old instruction', namespace: 'memory-evaluation' })).some(
        (row) => row.id === old.id,
      ),
    ).toBe(false)
    expect(await store.get(old.id)).toEqual(first)
    await expect(store.retire({ ...input, reason: 'Changed reason' })).rejects.toThrow('already retired')
    const newer = await seed('MCTS another current note.')
    await expect(
      store.retire({ id: newer.id, reason: 'invalid retired replacement', replacementId: old.id }),
    ).rejects.toThrow('active memory note')
  })

  it.each(['https://agents-shell.example.test', 'https://agents-shell-tunnel.example.test'])(
    'serves memory tools for %s without a repo session',
    async (resource) => {
      const config = defaultAgentsShellConfigFromEnv({
        AGENTS_SHELL_WORKSPACE_ROOT: root,
        AGENTS_SHELL_RESOURCE: resource,
        AGENTS_SHELL_MAX_OUTPUT_BYTES: '4096',
      })
      const auth: AuthContext = {
        subject: 'memory-test',
        email: 'test@example.test',
        username: 'test',
        scopes: new Set(['agents-shell.read']),
        payload: {},
      }
      const runner = new AgentsShellRunner(config)
      const audit = vi.spyOn(runner, 'audit').mockReturnValue(0)
      const server = createAgentsShellServer(config, runner, auth)
      const client = new Client({ name: 'memory-test', version: '1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      try {
        const content = 'MCTS candidate binding preserves matching metrics. 🦊漢字\n'.repeat(350)
        const saveInput = {
          namespace: `mcp-${new URL(resource).hostname}`,
          content,
          summary: 'MCTS candidate binding',
          tags: ['mcts'],
          repository: 'proompteng/lab',
          commit: 'a'.repeat(40),
        }
        const saved = await client.callTool({
          name: 'memory_save',
          arguments: saveInput,
        })
        expect(saved.isError).not.toBe(true)
        expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(4096)
        const savedBody = JSON.parse(
          CallToolResultSchema.parse(saved).content.find((item) => item.type === 'text')?.text ?? '{}',
        ) as {
          memory: { id: string }
        }
        const replay = await client.callTool({ name: 'memory_save', arguments: saveInput })
        expect(replay.structuredContent).toMatchObject({ memory: { id: savedBody.memory.id } })
        let offset = 0
        let complete = ''
        let reads = 0
        while (true) {
          const read = await client.callTool({ name: 'memory_get', arguments: { id: savedBody.memory.id, offset } })
          expect(read.isError).not.toBe(true)
          expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(4096)
          const page = asRecord(read.structuredContent)
          if (!page || typeof page.content !== 'string') throw new Error('Missing note content')
          complete += page.content
          if (page.nextOffset === null) break
          if (typeof page.nextOffset !== 'number') throw new Error('Missing content cursor')
          expect(page.nextOffset).toBeGreaterThan(offset)
          offset = page.nextOffset
          if (++reads > 100) throw new Error('Note reader did not make progress')
        }
        expect(complete).toBe(content.trim())
        const retired = await client.callTool({
          name: 'memory_retire',
          arguments: { id: savedBody.memory.id.toUpperCase(), reason: 'Synthetic integration-test note retired.' },
        })
        expect(retired.isError).not.toBe(true)
        expect(retired.structuredContent).toHaveProperty('memory.retiredAt', expect.any(String))
        expect(Buffer.byteLength(JSON.stringify(retired))).toBeLessThan(4096)
        const historical = await client.callTool({ name: 'memory_get', arguments: { id: savedBody.memory.id } })
        expect(historical.structuredContent).toHaveProperty('memory.retiredAt', expect.any(String))
        expect(historical.structuredContent).toHaveProperty(
          'memory.retirementReason',
          'Synthetic integration-test note retired.',
        )
        const list = await client.callTool({
          name: 'memory_list',
          arguments: { repository: 'proompteng/lab', model: 'test-model', limit: 2 },
        })
        expect(list.isError).not.toBe(true)
        expect(list.structuredContent).toHaveProperty('memories', expect.any(Array))
        expect(list.structuredContent).toMatchObject({ memories: [expect.any(Object), expect.any(Object)] })
        expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThanOrEqual(4096)
        const cursor = asRecord(list.structuredContent)?.nextCursor
        if (typeof cursor !== 'string') throw new Error('Missing list cursor')
        const following = await client.callTool({
          name: 'memory_list',
          arguments: { repository: 'proompteng/lab', model: 'test-model', limit: 2, cursor },
        })
        expect(following.isError).not.toBe(true)
        expect(following.structuredContent).not.toMatchObject({ memories: [{ id: cursor }] })
        const invalidSave = await client.callTool({ name: 'memory_save', arguments: { ...saveInput, commit: 'short' } })
        expect(invalidSave.isError).toBe(true)
        const oldShape = await client.callTool({
          name: 'memory_save',
          arguments: { ...saveInput, metadata: { repository: 'other/repo' } },
        })
        expect(oldShape.isError).toBe(true)
        const search = await client.callTool({
          name: 'retrieve_context',
          arguments: {
            query: 'MCTS candidate expression metrics evaluation',
            repository: 'proompteng/lab',
            expectedCommit: 'a'.repeat(40),
          },
        })
        expect(search.isError).not.toBe(true)
        expect(search.structuredContent).toHaveProperty('snapshotVerified', true)
        expect(search.structuredContent).toHaveProperty('memory.state', 'ready')
        expect(search.structuredContent).toHaveProperty('code.state', 'ready')
        expect(Buffer.byteLength(JSON.stringify(search))).toBeLessThan(4096)
        const invalid = await client.callTool({
          name: 'memory_retire',
          arguments: { id: 'invalid', reason: 'obsolete' },
        })
        expect(invalid.isError).toBe(true)
        for (const [, , payload] of audit.mock.calls) {
          expect(payload).not.toHaveProperty('arguments')
          expect(payload).not.toHaveProperty('result')
        }
      } finally {
        await client.close()
        await server.close()
      }
    },
  )
})
