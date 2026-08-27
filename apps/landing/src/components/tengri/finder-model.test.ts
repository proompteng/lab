import { describe, expect, test } from 'bun:test'
import type { TengriFileEntry } from '@/lib/tengri/types'

import {
  FINDER_WORKSPACE_PATH,
  finderCanMutate,
  finderCanPreviewContentType,
  finderChildPath,
  finderDeletionTargets,
  finderFileKind,
  finderRenamePath,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  updateFinderSelection,
} from './finder-model'

describe('Finder model', () => {
  test('opens the persistent project directory inside the Nanoagent home API root', () => {
    expect(FINDER_WORKSPACE_PATH).toBe('/workspace')
  })

  test('normalizes absolute paths without allowing root escape', () => {
    expect(normalizeFinderPath(' /workspace//src/./app/../index.ts ')).toBe('/workspace/src/index.ts')
    expect(normalizeFinderPath('/')).toBe('/')
    expect(normalizeFinderPath('workspace')).toBeNull()
    expect(normalizeFinderPath('/../workspace')).toBeNull()
    expect(normalizeFinderPath('/workspace\nsecret')).toBeNull()
  })

  test('formats sizes and dates without exposing invalid values', () => {
    expect(formatFinderBytes(512)).toBe('512 B')
    expect(formatFinderBytes(1536)).toBe('1.5 KB')
    expect(formatFinderBytes(-1)).toBe('—')
    expect(formatFinderDate('not-a-date')).toBe('—')
  })

  test('builds child and rename paths without rewriting invalid names', () => {
    expect(finderChildPath('/', 'src')).toBe('/src')
    expect(finderChildPath('/workspace', 'src')).toBe('/workspace/src')
    expect(finderChildPath('/workspace', '../src')).toBeNull()
    expect(finderChildPath('/workspace', 'src/index.ts')).toBeNull()
    expect(finderRenamePath('/workspace/old.ts', 'new.ts')).toBe('/workspace/new.ts')
    expect(finderRenamePath('/', 'new')).toBeNull()
  })

  test('supports replacement, additive toggles, and contiguous ranges', () => {
    const entries = ['/a', '/b', '/c', '/d'].map((path) => ({ path }))
    expect([...updateFinderSelection(new Set(['/a']), entries, '/c', { additive: false, range: false })]).toEqual([
      '/c',
    ])
    expect([...updateFinderSelection(new Set(['/a']), entries, '/c', { additive: true, range: false })]).toEqual([
      '/a',
      '/c',
    ])
    expect([
      ...updateFinderSelection(new Set(['/a']), entries, '/c', {
        additive: false,
        anchorPath: '/a',
        range: true,
      }),
    ]).toEqual(['/a', '/b', '/c'])
  })

  test('keeps an explicit range anchor stable across repeated selections', () => {
    const entries = ['/a', '/b', '/c', '/d'].map((path) => ({ path }))
    const first = updateFinderSelection(new Set(['/b']), entries, '/d', {
      additive: false,
      anchorPath: '/b',
      range: true,
    })
    expect([
      ...updateFinderSelection(first, entries, '/c', { additive: false, anchorPath: '/b', range: true }),
    ]).toEqual(['/b', '/c'])
  })

  test('protects the workspace root and prunes descendants covered by selected directories', () => {
    const entries = [
      { path: '/workspace', directory: true },
      { path: '/workspace/src', directory: true },
      { path: '/workspace/src/index.ts', directory: false },
      { path: '/workspace/README.md', directory: false },
    ] as TengriFileEntry[]
    expect(finderDeletionTargets(entries).map((entry) => entry.path)).toEqual([
      '/workspace/src',
      '/workspace/README.md',
    ])
    expect(finderCanMutate('/')).toBe(false)
    expect(finderCanMutate('/workspace')).toBe(false)
    expect(finderCanMutate('/workspace/README.md')).toBe(true)
    expect(finderCanMutate('workspace')).toBe(false)
  })

  test('previews text-like content types but rejects opaque binary files', () => {
    expect(finderCanPreviewContentType('text/plain; charset=utf-8')).toBe(true)
    expect(finderCanPreviewContentType('application/json')).toBe(true)
    expect(finderCanPreviewContentType('image/png')).toBe(false)
  })

  test('classifies folders, source files, and ordinary files', () => {
    expect(finderFileKind({ directory: true, name: 'src' })).toBe('folder')
    expect(finderFileKind({ directory: false, name: 'main.rs' })).toBe('code')
    expect(finderFileKind({ directory: false, name: 'archive.zip' })).toBe('file')
  })
})
