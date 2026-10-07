import { describe, expect, test } from 'bun:test'

import {
  MAX_STORED_CONVERSATIONS,
  conversationsStorageKey,
  markStoredConversationUnavailable,
  mergeConversationRegistry,
  readStoredConversations,
  touchStoredConversation,
  truncateConversationTitle,
  upsertStoredConversation,
  writeStoredConversations,
} from './agent-conversation-storage'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  failWrites = false

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
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
})
