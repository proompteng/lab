import { describe, expect, test } from 'bun:test'

import {
  FINDER_SEARCH_REFRESH_MS,
  FINDER_WORKSPACE_PATH,
  finderCanPreviewText,
  finderChildPath,
  finderDeletionDescription,
  finderDeletionTargets,
  finderFileKind,
  finderRenamePath,
  finderSearchRefreshInterval,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  updateFinderSelection,
} from './finder-model'

describe('Finder model', () => {
  test('normalizes absolute paths without allowing root escape', () => {
    expect(normalizeFinderPath('/workspace//src/./app/../index.ts')).toBe('/workspace/src/index.ts')
    expect(normalizeFinderPath('/')).toBe('/')
    expect(normalizeFinderPath('/workspace/file ')).toBe('/workspace/file ')
    expect(normalizeFinderPath(' /workspace')).toBeNull()
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

  test('builds child and rename paths without rewriting invalid names', () => {
    expect(finderChildPath('/', 'src')).toBe('/src')
    expect(finderChildPath('/workspace', 'src')).toBe('/workspace/src')
    expect(finderChildPath('/workspace', ' source ')).toBe('/workspace/ source ')
    expect(finderChildPath('/workspace', '../src')).toBeNull()
    expect(finderChildPath('/workspace', 'src/index.ts')).toBeNull()
    expect(finderRenamePath('/workspace/old.ts', 'new.ts')).toBe('/workspace/new.ts')
    expect(finderRenamePath('/workspace/old.ts', ' new.ts ')).toBe('/workspace/ new.ts ')
    expect(finderRenamePath('/', 'new')).toBeNull()
  })

  test('supports replacement, additive toggles, and stable contiguous ranges', () => {
    const entries = ['/a', '/b', '/c', '/d'].map((path) => ({ path }))
    const replaced = updateFinderSelection(new Set(['/a']), entries, '/c', '/a', {
      additive: false,
      range: false,
    })
    expect([...replaced.selected]).toEqual(['/c'])

    const added = updateFinderSelection(new Set(['/a']), entries, '/c', '/a', { additive: true, range: false })
    expect([...added.selected]).toEqual(['/a', '/c'])

    const firstRange = updateFinderSelection(new Set(['/a']), entries, '/c', '/a', {
      additive: false,
      range: true,
    })
    expect([...firstRange.selected]).toEqual(['/a', '/b', '/c'])
    expect(firstRange.anchorPath).toBe('/a')

    const secondRange = updateFinderSelection(firstRange.selected, entries, '/d', firstRange.anchorPath, {
      additive: false,
      range: true,
    })
    expect([...secondRange.selected]).toEqual(['/a', '/b', '/c', '/d'])
    expect(secondRange.anchorPath).toBe('/a')
  })

  test('protects the workspace root and removes redundant descendant delete targets', () => {
    expect(
      finderDeletionTargets([
        { directory: true, path: '/' },
        { directory: true, path: '/src' },
        { directory: false, path: '/src/index.ts' },
        { directory: false, path: '/README.md' },
      ]),
    ).toEqual([
      { directory: true, path: '/src' },
      { directory: false, path: '/README.md' },
    ])
  })

  test('describes delete targets with their disambiguating paths', () => {
    expect(finderDeletionDescription([{ path: '/src/index.ts' }])).toContain('/src/index.ts')
    expect(finderDeletionDescription([{ path: '/src/index.ts' }, { path: '/test/index.ts' }])).toContain(
      '/test/index.ts',
    )
  })

  test('previews only textual content types', () => {
    expect(finderCanPreviewText('text/plain; charset=utf-8')).toBe(true)
    expect(finderCanPreviewText('application/json')).toBe(true)
    expect(finderCanPreviewText('image/png')).toBe(false)
    expect(finderCanPreviewText('application/octet-stream')).toBe(false)
  })

  test('classifies folders, source files, and ordinary files', () => {
    expect(finderFileKind({ directory: true, name: 'src' })).toBe('folder')
    expect(finderFileKind({ directory: false, name: 'main.rs' })).toBe('code')
    expect(finderFileKind({ directory: false, name: 'archive.zip' })).toBe('file')
  })
})
