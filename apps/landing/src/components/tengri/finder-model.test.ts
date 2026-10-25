import { describe, expect, test } from 'bun:test'

import {
  FINDER_SEARCH_REFRESH_MS,
  FINDER_WORKSPACE_PATH,
  finderCanPreviewText,
  finderCanBeginRename,
  finderChildPath,
  finderDeletionDescription,
  finderDeletionTargets,
  finderFileKind,
  finderBreadcrumbs,
  finderKindLabel,
  finderRenamePath,
  finderSearchRefreshInterval,
  formatFinderBytes,
  formatFinderDate,
  normalizeFinderPath,
  retainVisibleFinderEntry,
  sortFinderEntries,
  updateFinderSelection,
} from './finder-model'

describe('Finder model', () => {
  test('keeps breadcrumb navigation inside the workspace', () => {
    expect(finderBreadcrumbs('/workspace/src/my folder')).toEqual([
      { name: 'Workspace', path: '/workspace' },
      { name: 'src', path: '/workspace/src' },
      { name: 'my folder', path: '/workspace/src/my folder' },
    ])
    expect(finderBreadcrumbs('/workspace')).toEqual([{ name: 'Workspace', path: '/workspace' }])
  })

  test('sorts naturally in both directions without changing the server order', () => {
    const entries = [
      {
        name: 'file10.ts',
        path: '/workspace/file10.ts',
        directory: false,
        size: 10,
        modifiedAt: '2026-09-01T00:00:00Z',
      },
      { name: 'file2.ts', path: '/workspace/file2.ts', directory: false, size: 2, modifiedAt: '2026-09-02T00:00:00Z' },
      { name: 'src', path: '/workspace/src', directory: true, size: 0, modifiedAt: '' },
    ]
    expect(sortFinderEntries(entries, { column: 'name', direction: 'ascending' }).map((entry) => entry.name)).toEqual([
      'file2.ts',
      'file10.ts',
      'src',
    ])
    expect(sortFinderEntries(entries, { column: 'size', direction: 'descending' }).map((entry) => entry.size)).toEqual([
      10, 2, 0,
    ])
    expect(sortFinderEntries(entries, { column: 'modified', direction: 'descending' })[0]?.name).toBe('file2.ts')
    expect(sortFinderEntries(entries, { column: 'kind', direction: 'ascending' })[0]?.name).toBe('src')
    expect(entries[0]?.name).toBe('file10.ts')
    expect(finderKindLabel({ name: 'README.md', directory: false })).toBe('Markdown document')
  })

  test('normalizes absolute paths without allowing root escape', () => {
    expect(normalizeFinderPath('/workspace//src/./app/../index.ts')).toBe('/workspace/src/index.ts')
    expect(normalizeFinderPath('/workspace')).toBe('/workspace')
    expect(normalizeFinderPath('/')).toBeNull()
    expect(normalizeFinderPath('/workspace/../other')).toBeNull()
    expect(normalizeFinderPath('/workspace/file ')).toBe('/workspace/file ')
    expect(normalizeFinderPath(' /workspace')).toBeNull()
    expect(normalizeFinderPath('workspace')).toBeNull()
    expect(normalizeFinderPath('/../workspace')).toBeNull()
    expect(normalizeFinderPath('/workspace\nsecret')).toBeNull()
  })

  test('uses the Nanoagent API root for the workspace', () => {
    expect(FINDER_WORKSPACE_PATH).toBe('/workspace')
  })

  test('refreshes recursive search only while Finder is active', () => {
    expect(finderSearchRefreshInterval(true, 'main')).toBe(FINDER_SEARCH_REFRESH_MS)
    expect(finderSearchRefreshInterval(true, '   ')).toBeNull()
    expect(finderSearchRefreshInterval(false, 'main')).toBeNull()
  })

  test('clears stale rename state when refreshed results no longer contain the item', () => {
    const renamed = { path: '/workspace/src/old.ts' }
    expect(retainVisibleFinderEntry(renamed, [{ path: '/workspace/src/new.ts' }])).toBeNull()
    expect(retainVisibleFinderEntry(renamed, [renamed])).toBe(renamed)
  })

  test('allows rename only for a visible non-root item while no mutation is pending', () => {
    expect(finderCanBeginRename({ path: '/workspace/src/index.ts' }, false)).toBe(true)
    expect(finderCanBeginRename({ path: '/workspace/src/index.ts' }, true)).toBe(false)
    expect(finderCanBeginRename({ path: FINDER_WORKSPACE_PATH }, false)).toBe(false)
    expect(finderCanBeginRename(null, false)).toBe(false)
  })

  test('formats sizes and dates without exposing invalid values', () => {
    expect(formatFinderBytes(512)).toBe('512 B')
    expect(formatFinderBytes(1536)).toBe('1.5 KB')
    expect(formatFinderBytes(-1)).toBe('—')
    expect(formatFinderDate('not-a-date')).toBe('—')
  })

  test('builds child and rename paths without rewriting invalid names', () => {
    expect(finderChildPath('/workspace/workspace', 'src')).toBe('/workspace/workspace/src')
    expect(finderChildPath('/workspace', 'src')).toBe('/workspace/src')
    expect(finderChildPath('/workspace', ' source ')).toBe('/workspace/ source ')
    expect(finderChildPath('/workspace', '../src')).toBeNull()
    expect(finderChildPath('/workspace', 'src/index.ts')).toBeNull()
    expect(finderRenamePath('/workspace/old.ts', 'new.ts')).toBe('/workspace/new.ts')
    expect(finderRenamePath('/workspace/old.ts', ' new.ts ')).toBe('/workspace/ new.ts ')
    expect(finderRenamePath('/workspace', 'new')).toBeNull()
  })

  test('supports replacement, additive toggles, and stable contiguous ranges', () => {
    const entries = ['/workspace/a', '/workspace/b', '/workspace/c', '/workspace/d'].map((path) => ({ path }))
    const replaced = updateFinderSelection(new Set(['/workspace/a']), entries, '/workspace/c', '/workspace/a', {
      additive: false,
      range: false,
    })
    expect([...replaced.selected]).toEqual(['/workspace/c'])

    const added = updateFinderSelection(new Set(['/workspace/a']), entries, '/workspace/c', '/workspace/a', {
      additive: true,
      range: false,
    })
    expect([...added.selected]).toEqual(['/workspace/a', '/workspace/c'])

    const firstRange = updateFinderSelection(new Set(['/workspace/a']), entries, '/workspace/c', '/workspace/a', {
      additive: false,
      range: true,
    })
    expect([...firstRange.selected]).toEqual(['/workspace/a', '/workspace/b', '/workspace/c'])
    expect(firstRange.anchorPath).toBe('/workspace/a')

    const secondRange = updateFinderSelection(firstRange.selected, entries, '/workspace/d', firstRange.anchorPath, {
      additive: false,
      range: true,
    })
    expect([...secondRange.selected]).toEqual(['/workspace/a', '/workspace/b', '/workspace/c', '/workspace/d'])
    expect(secondRange.anchorPath).toBe('/workspace/a')
  })

  test('protects the workspace root and removes redundant descendant delete targets', () => {
    expect(
      finderDeletionTargets([
        { directory: true, path: '/workspace' },
        { directory: true, path: '/workspace/src' },
        { directory: false, path: '/workspace/src/index.ts' },
        { directory: false, path: '/workspace/README.md' },
      ]),
    ).toEqual([
      { directory: true, path: '/workspace/src' },
      { directory: false, path: '/workspace/README.md' },
    ])
  })

  test('describes delete targets with their disambiguating paths', () => {
    expect(finderDeletionDescription([{ path: '/workspace/src/index.ts' }])).toContain('/workspace/src/index.ts')
    expect(
      finderDeletionDescription([{ path: '/workspace/src/index.ts' }, { path: '/workspace/test/index.ts' }]),
    ).toContain('/workspace/test/index.ts')
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
