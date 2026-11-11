import {
  parseRepoContextInput,
  type AgentsMemoryNoteRecord,
  type ResolvedRepoContextInput,
} from '@proompteng/agent-contracts'
import { describe, expect, it, vi } from 'vitest'

import { retrieveRepoContext } from './repo-context'

const commit = 'a'.repeat(40)
const input = (overrides: Partial<ResolvedRepoContextInput> = {}): ResolvedRepoContextInput => ({
  query: 'MCTS candidate expression metrics',
  repository: 'proompteng/lab',
  expectedCommit: commit,
  limit: 3,
  maxBytes: 20_000,
  ...overrides,
})
const hit = (
  path = 'services/agents/src/server/memory-notes-store.ts',
  snippet = 'export const retrieve = () => memories',
) => ({
  repository: 'proompteng/lab',
  ref: 'main',
  commit,
  contentHash: 'b'.repeat(64),
  path,
  startLine: 1,
  endLine: 20,
  snippet,
  degradation: null,
})
const code = (items: unknown[] = [hit()]) =>
  Response.json({ ok: true, indexHealth: { status: 'ok', indexedCommit: commit }, items })
const note = (content = 'MCTS candidates must bind one design and its metrics.'): AgentsMemoryNoteRecord => ({
  id: 'test-note',
  namespace: 'test',
  content,
  summary: 'MCTS candidate evidence binding',
  tags: ['mcts'],
  metadata: { repository: 'proompteng/lab', commit: 'c'.repeat(40), noteModel: 'qwen38-flamingo' },
  createdAt: '2026-11-10T00:00:00Z',
  retiredAt: null,
  retirementReason: null,
  replacementId: null,
})

describe('repository context', () => {
  it('combines current code with historical note provenance and distinct source paths', async () => {
    const retrieve = vi.fn(async () => [note()])
    const fetch = vi.fn(async () => code([hit(), hit(), hit('docs/agents/memory-notes.md')]))
    const result = await retrieveRepoContext(input(), { retrieve }, { fetch })
    expect(result.snapshotVerified).toBe(true)
    expect(result.indexedCommit).toBe(commit)
    expect(result.code).toMatchObject({
      state: 'ready',
      items: [{ path: 'services/agents/src/server/memory-notes-store.ts' }, { path: 'docs/agents/memory-notes.md' }],
    })
    expect(result.memory).toMatchObject({
      state: 'ready',
      items: [{ id: 'test-note', commit: 'c'.repeat(40), createdAt: '2026-11-10T00:00:00Z' }],
    })
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ repository: 'proompteng/lab', limit: 3 }))
  })

  it('withholds stale code without hiding usable notes', async () => {
    const result = await retrieveRepoContext(
      input({ expectedCommit: 'd'.repeat(40) }),
      { retrieve: async () => [note()] },
      { fetch: async () => code() },
    )
    expect(result.snapshotVerified).toBe(false)
    expect(result.code).toMatchObject({ state: 'stale', items: [] })
    expect(result.memory.state).toBe('ready')
  })

  it('does not claim snapshot verification when no checkout commit is supplied', async () => {
    const result = await retrieveRepoContext(
      input({ expectedCommit: undefined }),
      { retrieve: async () => [] },
      { fetch: async () => code([]) },
    )
    expect(result.code).toMatchObject({ state: 'ready', items: [] })
    expect(result.snapshotVerified).toBe(false)
  })

  it('distinguishes unavailable sources from an empty successful search', async () => {
    const failed = await retrieveRepoContext(
      input(),
      {
        retrieve: async () => {
          throw new Error('memory database unavailable')
        },
      },
      { fetch: async () => Response.json({ ok: false, error: 'Atlas is building' }, { status: 503 }) },
    )
    expect(failed.code).toMatchObject({ state: 'unavailable', message: 'Atlas is building' })
    expect(failed.memory).toMatchObject({ state: 'unavailable', message: 'memory database unavailable' })
    const empty = await retrieveRepoContext(input(), { retrieve: async () => [] }, { fetch: async () => code([]) })
    expect(empty.code).toMatchObject({ state: 'ready', items: [] })
    expect(empty.memory).toMatchObject({ state: 'ready', items: [] })
  })

  it('preserves code results during a memory outage', async () => {
    const result = await retrieveRepoContext(
      input(),
      {
        retrieve: async () => {
          throw new Error('embedding timeout')
        },
      },
      { fetch: async () => code() },
    )
    expect(result.code.state).toBe('ready')
    expect(result.memory).toMatchObject({ state: 'unavailable', message: 'embedding timeout' })
  })

  it.each([
    { ...hit(), repository: 'other/repo' },
    { ...hit(), commit: 'd'.repeat(40) },
    { ...hit(), contentHash: 'missing' },
    { ...hit(), degradation: 'semantic retrieval unavailable' },
    { ...hit(), path: '../outside-repository' },
  ])('rejects inconsistent or degraded source evidence', async (item) => {
    const result = await retrieveRepoContext(input(), { retrieve: async () => [] }, { fetch: async () => code([item]) })
    expect(result.code).toMatchObject({ state: 'degraded', items: [] })
  })

  it('bounds generated schemas and Unicode note content without losing source identity', async () => {
    const long = '源コード 🦊 '.repeat(10_000)
    const result = await retrieveRepoContext(
      input({ maxBytes: 4096 }),
      { retrieve: async () => [note(long), note(long)] },
      { fetch: async () => code([hit('schemas/generated.json', long), hit('services/source.ts', long)]) },
    )
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
    expect(result.snapshotVerified).toBe(true)
    if (result.code.state !== 'ready' || result.memory.state !== 'ready') throw new Error('sources failed')
    for (const item of [...result.code.items, ...result.memory.items]) {
      expect(item.truncated).toBe(true)
      expect(item.excerpt).not.toContain('\ufffd')
    }
    expect(result.code.items[0]).toMatchObject({ path: 'schemas/generated.json', commit, contentHash: 'b'.repeat(64) })
  })

  it.each([
    { expectedCommit: 42 },
    { expectedCommit: '' },
    { expectedCommit: 'short' },
    { pathPrefix: '../secrets' },
    { maxBytes: 100 },
    { limit: 11 },
  ])('rejects invalid request boundaries', (bad) => {
    expect(parseRepoContextInput({ query: 'lookup', ...bad }).ok).toBe(false)
  })
})
