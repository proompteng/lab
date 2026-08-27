import { describe, expect, test } from 'bun:test'

import {
  FINDER_SEARCH_REFRESH_MS,
  FINDER_WORKSPACE_PATH,
  finderFileKind,
  finderSearchRefreshInterval,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
} from './finder-model'

describe('Finder model', () => {
  test('normalizes absolute paths without allowing root escape', () => {
    expect(normalizeFinderPath(' /workspace//src/./app/../index.ts ')).toBe('/workspace/src/index.ts')
    expect(normalizeFinderPath('/')).toBe('/')
    expect(normalizeFinderPath('workspace')).toBeNull()
    expect(normalizeFinderPath('/../workspace')).toBeNull()
    expect(normalizeFinderPath('/workspace\nsecret')).toBeNull()
  })

  test('uses the Nanoagent API root for the workspace', () => {
    expect(FINDER_WORKSPACE_PATH).toBe('/')
  })

  test('refreshes recursive search only while Finder is active', () => {
    expect(finderSearchRefreshInterval(true, 'main')).toBe(FINDER_SEARCH_REFRESH_MS)
    expect(finderSearchRefreshInterval(true, '   ')).toBeNull()
    expect(finderSearchRefreshInterval(false, 'main')).toBeNull()
  })

  test('formats sizes and dates without exposing invalid values', () => {
    expect(formatFinderBytes(512)).toBe('512 B')
    expect(formatFinderBytes(1536)).toBe('1.5 KB')
    expect(formatFinderBytes(-1)).toBe('—')
    expect(formatFinderDate('not-a-date')).toBe('—')
  })

  test('classifies folders, source files, and ordinary files', () => {
    expect(finderFileKind({ directory: true, name: 'src' })).toBe('folder')
    expect(finderFileKind({ directory: false, name: 'main.rs' })).toBe('code')
    expect(finderFileKind({ directory: false, name: 'archive.zip' })).toBe('file')
  })
})
