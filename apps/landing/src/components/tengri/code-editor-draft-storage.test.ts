import { describe, expect, test } from 'bun:test'

import {
  CODE_DRAFT_STORAGE_PREFIX,
  MAX_CODE_DRAFT_CONTENT_BYTES,
  MAX_CODE_DRAFT_ENTRIES,
  MAX_CODE_DRAFT_MEMORY_ENTRIES,
  codeDraftStorageKey,
  createBrowserCodeDraftStore,
  createCodeDraft,
  createCodeDraftStore,
  forgetCodeDraft,
  getVolatileCodeDrafts,
  markCodeDraftDurable,
  markCodeDraftVolatile,
  mergeCodeDraftContent,
  parseCodeRevision,
  rememberCodeDraft,
  rememberedCodeDraft,
  subscribeVolatileCodeDrafts,
  type CodeDraftIdentity,
} from './code-editor-draft-storage'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  failReads = false
  failWrites = false

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    if (this.failReads) throw new Error('storage read failed')
    return this.values.get(key) ?? null
  }

  key(index: number) {
    if (this.failReads) throw new Error('storage read failed')
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    if (this.failWrites) throw new Error('storage write failed')
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('storage write failed')
    this.values.set(key, value)
  }
}

const identity: CodeDraftIdentity = {
  ownerId: 'github:42',
  agentCreatedAt: '2026-09-07T12:00:00.000Z',
  agentId: 'agent-1',
  path: '/workspace/README.md',
}

const revision = 'a'.repeat(64)

describe('Code editor draft storage', () => {
  test('validates revisions and isolates drafts by owner, VM incarnation, and path', () => {
    expect(parseCodeRevision(revision)).toBe(revision)
    expect(parseCodeRevision('A'.repeat(64))).toBeNull()
    expect(parseCodeRevision('missing')).toBe('missing')
    expect(parseCodeRevision('')).toBeNull()

    const storage = new MemoryStorage()
    const store = createCodeDraftStore(storage)
    const draft = createCodeDraft(identity, 'local edit', revision, 'text/markdown', 100)
    expect(store.write(draft)).toEqual({ kind: 'stored' })
    expect(store.read(identity)).toEqual({ kind: 'found', draft })
    expect(store.read(null as unknown as CodeDraftIdentity)).toEqual({ kind: 'missing' })
    expect(store.read({ ...identity, ownerId: 'github:other' })).toEqual({ kind: 'missing' })
    expect(store.read({ ...identity, agentCreatedAt: '2026-09-07T13:00:00.000Z' })).toEqual({ kind: 'missing' })
    expect(store.read({ ...identity, path: '/workspace/other.md' })).toEqual({ kind: 'missing' })
  })

  test('keeps an older same-file draft after removing the newest writer', () => {
    const storage = new MemoryStorage()
    const store = createCodeDraftStore(storage)
    const older = createCodeDraft(identity, 'older edit', revision, 'text/plain', 100, 'writer-a')
    const newer = createCodeDraft(identity, 'newer edit', revision, 'text/plain', 200, 'writer-b')
    expect(store.write(older)).toEqual({ kind: 'stored' })
    expect(store.write(newer)).toEqual({ kind: 'stored' })
    expect(store.read(identity)).toEqual({ kind: 'found', draft: newer })
    expect(store.remove(identity, newer.draftId)).toEqual({ kind: 'removed' })
    expect(store.read(identity)).toEqual({ kind: 'found', draft: older })
  })

  test('ignores malformed entries without deleting them when writing a valid draft', () => {
    const storage = new MemoryStorage()
    const key = codeDraftStorageKey(identity)
    storage.setItem(key, '{not json')
    const store = createCodeDraftStore(storage)

    expect(store.read(identity)).toEqual({ kind: 'missing' })
    expect(store.write(createCodeDraft(identity, 'fixed', revision, 'text/plain', 200))).toEqual({ kind: 'stored' })
    expect(storage.getItem(key)).toBe('{not json')
    expect(storage.length).toBe(2)
    expect(store.read(identity)).toEqual({ kind: 'found', draft: expect.objectContaining({ content: 'fixed' }) })
  })

  test('rejects new drafts at the bound without evicting existing recoverable content', () => {
    const storage = new MemoryStorage()
    const store = createCodeDraftStore(storage)
    for (let index = 0; index < MAX_CODE_DRAFT_ENTRIES; index += 1) {
      const draftIdentity = { ...identity, path: `/workspace/${index}.md` }
      expect(store.write(createCodeDraft(draftIdentity, String(index), revision, 'text/plain', index + 1))).toEqual({
        kind: 'stored',
      })
    }

    const newestIdentity = { ...identity, path: '/workspace/new.md' }
    expect(store.write(createCodeDraft(newestIdentity, 'new', revision, 'text/plain', 100))).toEqual({
      kind: 'rejected',
      message: 'Code recovery storage is full. Download this draft before closing the editor.',
    })
    expect(store.read({ ...identity, path: '/workspace/0.md' })).toEqual({
      kind: 'found',
      draft: expect.objectContaining({ content: '0' }),
    })
    expect(storage.length).toBe(MAX_CODE_DRAFT_ENTRIES)

    const oversized = 'x'.repeat(MAX_CODE_DRAFT_CONTENT_BYTES + 1)
    expect(store.write(createCodeDraft(identity, oversized, revision, 'text/plain', 101))).toEqual({
      kind: 'rejected',
      message: 'The edited draft is too large to keep for recovery.',
    })

    const oversizedDraft = createCodeDraft(identity, oversized, revision, 'text/plain', 102, 'oversized-writer')
    expect(rememberCodeDraft(oversizedDraft)).toBe(true)
    expect(markCodeDraftVolatile(oversizedDraft)).toBe(true)
    expect(getVolatileCodeDrafts()).toContainEqual(oversizedDraft)
    forgetCodeDraft(identity, oversizedDraft.draftId)
  })

  test('reports storage failures instead of pretending a draft was persisted', () => {
    const storage = new MemoryStorage()
    const store = createCodeDraftStore(storage)
    storage.failWrites = true
    expect(store.write(createCodeDraft(identity, 'edit', revision, 'text/plain'))).toEqual({
      kind: 'unavailable',
      message: expect.stringContaining('could not save this draft for recovery'),
    })
    storage.failWrites = false
    expect(store.write(createCodeDraft(identity, 'edit', revision, 'text/plain'))).toEqual({ kind: 'stored' })
    storage.failReads = true
    expect(store.read(identity)).toEqual({
      kind: 'unavailable',
      message: expect.stringContaining('could not inspect the recovery draft'),
    })
  })

  test('keeps a same-document draft available across editor unmounts', () => {
    const draft = createCodeDraft(identity, 'memory edit', revision, 'text/plain', 500, 'editor-tab-a')
    rememberCodeDraft(draft)
    expect(rememberedCodeDraft(identity)).toEqual(draft)
    forgetCodeDraft(identity, 'editor-tab-a')
    expect(rememberedCodeDraft(identity)).toBeUndefined()
  })

  test('keeps the volatile fallback when the bounded normal memory cache is full', () => {
    const cachedDrafts = Array.from({ length: MAX_CODE_DRAFT_MEMORY_ENTRIES }, (_, index) =>
      createCodeDraft(
        { ...identity, path: `/workspace/cache-${index}.md` },
        `cached ${index}`,
        revision,
        'text/plain',
        1_000 + index,
        `cached-writer-${index}`,
      ),
    )
    for (const draft of cachedDrafts) expect(rememberCodeDraft(draft)).toBe(true)

    const overflow = createCodeDraft(identity, 'overflow edit', revision, 'text/plain', 2_000, 'overflow-writer')
    expect(rememberCodeDraft(overflow)).toBe(false)
    expect(markCodeDraftVolatile(overflow)).toBe(true)
    expect(rememberedCodeDraft(identity)).toEqual(overflow)
    expect(getVolatileCodeDrafts()).toContainEqual(overflow)

    forgetCodeDraft(identity, overflow.draftId)
    for (const draft of cachedDrafts) forgetCodeDraft(draft, draft.draftId)
  })

  test('publishes only drafts without durable storage and clears them after persistence', () => {
    const draft = createCodeDraft(
      { ...identity, path: '/workspace/volatile.md' },
      'volatile edit',
      revision,
      'text/plain',
      600,
    )
    let notifications = 0
    const unsubscribe = subscribeVolatileCodeDrafts(() => {
      notifications += 1
    })
    expect(markCodeDraftVolatile(draft)).toBe(true)
    expect(getVolatileCodeDrafts()).toEqual([draft])
    markCodeDraftDurable(draft)
    expect(getVolatileCodeDrafts()).toEqual([])
    expect(notifications).toBe(2)
    unsubscribe()
  })

  test('merges conflicting content while retaining both complete versions', () => {
    expect(mergeCodeDraftContent('server version', 'local version')).toBe(
      '<<<<<<< server\nserver version\n=======\nlocal version\n>>>>>>> local draft',
    )
  })

  test('returns an unavailable store when browser localStorage cannot be accessed', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage blocked')
      },
    })
    try {
      const store = createBrowserCodeDraftStore()
      expect(store.read(identity)).toEqual({
        kind: 'unavailable',
        message: expect.stringContaining('could not read the recovery draft'),
      })
      expect(CODE_DRAFT_STORAGE_PREFIX).toContain('tengri:code-draft')
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})
