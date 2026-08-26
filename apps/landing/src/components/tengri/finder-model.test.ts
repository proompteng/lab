import { describe, expect, test } from 'bun:test'

import {
  finderChildPath,
  finderFileKind,
  finderRenamePath,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  updateFinderSelection,
} from './finder-model'

describe('Finder model', () => {
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
    expect([...updateFinderSelection(new Set(['/a']), entries, '/c', { additive: false, range: true })]).toEqual([
      '/a',
      '/b',
      '/c',
    ])
  })

  test('classifies folders, source files, and ordinary files', () => {
    expect(finderFileKind({ directory: true, name: 'src' })).toBe('folder')
    expect(finderFileKind({ directory: false, name: 'main.rs' })).toBe('code')
    expect(finderFileKind({ directory: false, name: 'archive.zip' })).toBe('file')
  })
})
