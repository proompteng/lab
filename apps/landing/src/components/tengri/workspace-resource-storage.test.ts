import { describe, expect, test } from 'bun:test'
import { MemoryStorage } from '@/lib/tengri/storage.fixture'
import {
  MAX_WORKSPACE_RESOURCES,
  readWorkspacePins,
  readWorkspaceResources,
  workspacePinsKey,
  workspaceResourcesKey,
  writeWorkspacePins,
  writeWorkspaceResources,
} from './workspace-resource-storage'

describe('workspace resource persistence', () => {
  test('restores exact file locations and the selected tab independently of pins', () => {
    const tabs = new MemoryStorage()
    const pins = new MemoryStorage()
    const file = { path: '/workspace/src/main.ts', line: 12, column: 3 }
    expect(writeWorkspaceResources('agent-a', { tabs: [file], activePath: file.path }, tabs)).toBe(true)
    expect(writeWorkspacePins('agent-a', [file], pins)).toBe(true)
    expect(readWorkspaceResources('agent-a', tabs)).toEqual({ tabs: [file], activePath: file.path })
    expect(writeWorkspaceResources('agent-a', { tabs: [], activePath: null }, tabs)).toBe(true)
    expect(readWorkspacePins('agent-a', pins)).toEqual([file])
    expect(readWorkspaceResources('agent-b', tabs)).toEqual({ tabs: [], activePath: null })
    expect(readWorkspacePins('agent-b', pins)).toEqual([])
  })

  test('window tab selections cannot overwrite shared pins or another window selection', () => {
    const windowA = new MemoryStorage()
    const windowB = new MemoryStorage()
    const pins = new MemoryStorage()
    const file = { path: '/workspace/README.md' }
    writeWorkspacePins('agent-a', [file], pins)
    writeWorkspaceResources('agent-a', { tabs: [file], activePath: file.path }, windowA)
    writeWorkspaceResources('agent-a', { tabs: [], activePath: null }, windowB)
    expect(readWorkspaceResources('agent-a', windowA).activePath).toBe(file.path)
    expect(readWorkspaceResources('agent-a', windowB).activePath).toBeNull()
    expect(readWorkspacePins('agent-a', pins)).toEqual([file])
  })

  for (const invalid of [
    { path: '/etc/passwd' },
    { path: '/workspace/../etc/passwd' },
    { path: '/workspace/./token' },
    { path: 'https://example.test/workspace/file' },
    { path: '/workspace/README.md', line: -1 },
    { path: '/workspace/README.md', column: 3 },
    { path: '/workspace/README.md', line: 1.5 },
    { path: '/workspace/README.md', content: 'file contents must not be persisted' },
  ]) {
    test(`rejects untrusted resource metadata ${JSON.stringify(invalid)}`, () => {
      const storage = new MemoryStorage()
      storage.setItem(workspaceResourcesKey('agent-a'), JSON.stringify({ tabs: [invalid], activePath: null }))
      storage.setItem(workspacePinsKey('agent-a'), JSON.stringify([invalid]))
      expect(readWorkspaceResources('agent-a', storage)).toEqual({ tabs: [], activePath: null })
      expect(readWorkspacePins('agent-a', storage)).toEqual([])
    })
  }

  test('rejects missing active tabs, duplicate paths, excessive tabs and malformed JSON', () => {
    const storage = new MemoryStorage()
    const file = { path: '/workspace/README.md' }
    for (const state of [
      { tabs: [file], activePath: '/workspace/missing.md' },
      { tabs: [file, file], activePath: null },
      {
        tabs: Array.from({ length: MAX_WORKSPACE_RESOURCES + 1 }, (_, index) => ({ path: `/workspace/${index}.md` })),
        activePath: null,
      },
    ]) {
      storage.setItem(workspaceResourcesKey('agent-a'), JSON.stringify(state))
      expect(readWorkspaceResources('agent-a', storage)).toEqual({ tabs: [], activePath: null })
    }
    storage.setItem(workspaceResourcesKey('agent-a'), '{')
    storage.setItem(workspacePinsKey('agent-a'), '{')
    expect(readWorkspaceResources('agent-a', storage)).toEqual({ tabs: [], activePath: null })
    expect(readWorkspacePins('agent-a', storage)).toEqual([])
  })

  test('reports unavailable storage without preventing workspace use', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage blocked')
      },
      setItem: () => {
        throw new Error('storage blocked')
      },
    }
    expect(readWorkspaceResources('agent-a', storage)).toEqual({ tabs: [], activePath: null })
    expect(readWorkspacePins('agent-a', storage)).toEqual([])
    expect(writeWorkspaceResources('agent-a', { tabs: [], activePath: null }, storage)).toBe(false)
    expect(writeWorkspacePins('agent-a', [], storage)).toBe(false)
  })
})
