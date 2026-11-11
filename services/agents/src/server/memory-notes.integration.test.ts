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
import { getMemoryNotesHandler, postMemoryNotesHandler, postRetireMemoryNoteHandler } from './v1/memory-notes'

vi.mock('./kysely-migrations', () => ({ ensureMigrations: async () => undefined }))

const url = process.env.AGENTS_STORE_TEST_DATABASE_URL
describe.skipIf(!url)('Memory notes on PostgreSQL through API, CLI and MCP', () => {
  const databaseName = `memory_test_${crypto.randomUUID().replaceAll('-', '')}`
  const root = mkdtempSync(join(tmpdir(), 'memory-shell-test-'))
  const previous = { dimension: process.env.OPENAI_EMBEDDING_DIMENSION, baseUrl: process.env.AGENTS_SERVICE_BASE_URL }
  let admin: Pool
  let db: Kysely<AgentsDatabase>
  let store: ReturnType<typeof createPostgresMemoriesStore>
  let api: ReturnType<typeof createServer>
  let baseUrl: string

  beforeAll(async () => {
    if (!url) throw new Error('AGENTS_STORE_TEST_DATABASE_URL is required')
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
        const result = request.url?.startsWith('/v1/memory-notes/retire')
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
      (await store.retrieve({ query: 'MCTS old instruction', namespace: 'memory-evaluation' })).some(
        (row) => row.id === old.id,
      ),
    ).toBe(false)
    expect((await store.list({ includeRetired: true })).find((row) => row.id === old.id)).toEqual(first)
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
        const saved = await client.callTool({
          name: 'memory_save',
          arguments: {
            namespace: 'mcp-evaluation',
            content: 'MCTS candidate binding must preserve matching metrics.',
            summary: 'MCTS candidate binding',
            tags: ['mcts'],
            metadata: { repository: 'proompteng/lab' },
          },
        })
        expect(saved.isError).not.toBe(true)
        const savedBody = JSON.parse(
          CallToolResultSchema.parse(saved).content.find((item) => item.type === 'text')?.text ?? '{}',
        ) as {
          memory: { id: string }
        }
        const retired = await client.callTool({
          name: 'memory_retire',
          arguments: { id: savedBody.memory.id, reason: 'Synthetic integration-test note retired.' },
        })
        expect(retired.isError).not.toBe(true)
        expect(retired.structuredContent).toHaveProperty(
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
        const search = await client.callTool({
          name: 'memory_search',
          arguments: { query: 'MCTS candidate expression metrics evaluation', repository: 'proompteng/lab' },
        })
        expect(search.isError).not.toBe(true)
        expect(search.structuredContent).toHaveProperty('memories', expect.arrayContaining([expect.any(Object)]))
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
