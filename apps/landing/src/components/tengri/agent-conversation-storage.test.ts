import { afterEach, describe, expect, test } from 'bun:test'

import {
  MAX_STORED_CONVERSATIONS,
  conversationsStorageKey,
  markStoredConversationUnavailable,
  mergeConversationRegistry,
  mergePersistedConversationRegistry,
  readStoredConversations,
  touchStoredConversation,
  truncateConversationTitle,
  upsertStoredConversation,
  writeStoredConversations,
} from './agent-conversation-storage'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  failWrites = false
  failReads = false

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

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

describe('agent conversation storage', () => {
  test('truncates titles and caps the registry', () => {
    expect(truncateConversationTitle('  hello   world  ')).toBe('hello world')
    expect(truncateConversationTitle('x'.repeat(60))).toBe(`${'x'.repeat(45)}…`)
    expect(conversationsStorageKey('agent-1')).toBe('tengri-conversations:agent-1')

    const many = Array.from({ length: MAX_STORED_CONVERSATIONS + 5 }, (_, index) => ({
      id: `thread-${index}`,
      title: `Conversation ${index}`,
      updatedAt: index,
    }))
    expect(mergeConversationRegistry(many, { id: 'thread-new', title: 'Newest', updatedAt: 999 }).length).toBe(
      MAX_STORED_CONVERSATIONS,
    )
  })

  test('keeps the in-memory registry when persistence writes fail', () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    const first = upsertStoredConversation('agent-1', { id: 'thread-a', title: 'Alpha', updatedAt: 1 }, [], storage)
    expect(first).toEqual([{ id: 'thread-a', title: 'Alpha', updatedAt: 1 }])
    expect(storage.getItem(conversationsStorageKey('agent-1'))).toBeNull()

    const second = upsertStoredConversation('agent-1', { id: 'thread-b', title: 'Beta', updatedAt: 2 }, first, storage)
    expect(second.map((conversation) => conversation.id)).toEqual(['thread-b', 'thread-a'])
    expect(readStoredConversations('agent-1', storage)).toEqual([])

    const touched = touchStoredConversation('agent-1', 'thread-a', second, 3, storage)
    expect(touched.map((conversation) => conversation.id)).toEqual(['thread-a', 'thread-b'])
    expect(touched[0]?.updatedAt).toBe(3)

    const unavailable = markStoredConversationUnavailable('agent-1', 'thread-b', touched, 4, storage)
    expect(unavailable.find((conversation) => conversation.id === 'thread-b')?.unavailable).toBe(true)
    expect(unavailable.map((conversation) => conversation.id)).toEqual(['thread-a', 'thread-b'])
  })

  test('persists when storage writes succeed and prefers richer titles', () => {
    const storage = new MemoryStorage()
    const seeded = writeStoredConversations('agent-1', [{ id: 'thread-a', title: 'Alpha', updatedAt: 1 }], storage)
    const next = upsertStoredConversation(
      'agent-1',
      { id: 'thread-a', title: 'New conversation', updatedAt: 2 },
      seeded,
      storage,
    )
    expect(next[0]).toEqual({ id: 'thread-a', title: 'Alpha', updatedAt: 2 })
    expect(readStoredConversations('agent-1', storage)).toEqual(next)
  })

  test('merges registry writes with persisted entries from another tab', () => {
    const storage = new MemoryStorage()
    writeStoredConversations('agent-1', [{ id: 'from-tab-b', title: 'Tab B', updatedAt: 1 }], storage)

    // Tab A only knows about its own in-memory registry (stale relative to storage).
    const tabA = upsertStoredConversation('agent-1', { id: 'from-tab-a', title: 'Tab A', updatedAt: 2 }, [], storage)
    expect(tabA.map((conversation) => conversation.id)).toEqual(['from-tab-a', 'from-tab-b'])
    expect(readStoredConversations('agent-1', storage).map((conversation) => conversation.id)).toEqual([
      'from-tab-a',
      'from-tab-b',
    ])

    // Tab B upserts again with a stale local snapshot that omits Tab A's thread.
    const tabB = upsertStoredConversation(
      'agent-1',
      { id: 'from-tab-b', title: 'Tab B updated', updatedAt: 3 },
      [{ id: 'from-tab-b', title: 'Tab B', updatedAt: 1 }],
      storage,
    )
    expect(tabB.map((conversation) => conversation.id)).toEqual(['from-tab-b', 'from-tab-a'])
    expect(tabB[0]).toEqual({ id: 'from-tab-b', title: 'Tab B updated', updatedAt: 3 })
    expect(readStoredConversations('agent-1', storage)).toEqual(tabB)
  })

  test('mergePersistedConversationRegistry keeps preferred titles and sorts by recency', () => {
    const merged = mergePersistedConversationRegistry(
      [{ id: 'a', title: 'New conversation', updatedAt: 5 }],
      [
        { id: 'a', title: 'Alpha', updatedAt: 1 },
        { id: 'b', title: 'Beta', updatedAt: 4 },
      ],
    )
    expect(merged).toEqual([
      { id: 'a', title: 'Alpha', updatedAt: 5 },
      { id: 'b', title: 'Beta', updatedAt: 4 },
    ])
  })

  test('survives SecurityError when resolving the localStorage global', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Denied', 'SecurityError')
      },
    })

    expect(readStoredConversations('agent-1')).toEqual([])
    expect(writeStoredConversations('agent-1', [{ id: 'thread-a', title: 'Alpha', updatedAt: 1 }])).toEqual([
      { id: 'thread-a', title: 'Alpha', updatedAt: 1 },
    ])
    expect(
      upsertStoredConversation('agent-1', { id: 'thread-b', title: 'Beta', updatedAt: 2 }, [
        { id: 'thread-a', title: 'Alpha', updatedAt: 1 },
      ]),
    ).toEqual([
      { id: 'thread-b', title: 'Beta', updatedAt: 2 },
      { id: 'thread-a', title: 'Alpha', updatedAt: 1 },
    ])
  })
})
