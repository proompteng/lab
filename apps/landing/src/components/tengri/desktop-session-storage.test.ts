import { afterEach, describe, expect, test } from 'bun:test'

import { clearDeletedDesktopState } from './desktop-session-storage'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

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
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const originalStorageDescriptors = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
}

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originalStorageDescriptors)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

describe('clearDeletedDesktopState', () => {
  test('clears deleted-agent desktop, thread, and Spotlight state without touching another agent', () => {
    const session = new MemoryStorage()
    const local = new MemoryStorage()
    session.setItem('tengri:desktop:agent-a', 'desktop-a')
    session.setItem('tengri:windows:agent-a:desktop-a', '{}')
    session.setItem('tengri:terminal:agent-a:desktop-a:terminal-1', '{}')
    session.setItem('tengri:desktop:agent-b', 'desktop-b')
    local.setItem('tengri-thread:agent-a', 'thread-a')
    local.setItem('tengri:spotlight:agent-a:recents', '["app:chrome"]')
    local.setItem('tengri-thread:agent-b', 'thread-b')
    local.setItem('tengri:spotlight:agent-b:recents', '["app:finder"]')
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local })

    clearDeletedDesktopState('agent-a')

    expect(session.getItem('tengri:desktop:agent-a')).toBeNull()
    expect(session.getItem('tengri:windows:agent-a:desktop-a')).toBeNull()
    expect(session.getItem('tengri:terminal:agent-a:desktop-a:terminal-1')).toBeNull()
    expect(session.getItem('tengri:desktop:agent-b')).toBe('desktop-b')
    expect(local.getItem('tengri-thread:agent-a')).toBeNull()
    expect(local.getItem('tengri:spotlight:agent-a:recents')).toBeNull()
    expect(local.getItem('tengri-thread:agent-b')).toBe('thread-b')
    expect(local.getItem('tengri:spotlight:agent-b:recents')).toBe('["app:finder"]')
  })

  test('clears local agent state when sessionStorage is unavailable', () => {
    const local = new MemoryStorage()
    local.setItem('tengri-thread:agent-a', 'thread-a')
    local.setItem('tengri:spotlight:agent-a:recents', '["app:chrome"]')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        get length(): number {
          throw new Error('session storage unavailable')
        },
      },
    })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local })

    clearDeletedDesktopState('agent-a')

    expect(local.getItem('tengri-thread:agent-a')).toBeNull()
    expect(local.getItem('tengri:spotlight:agent-a:recents')).toBeNull()
  })
})
