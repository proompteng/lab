import { describe, expect, test } from 'bun:test'

import {
  canStartEditorSave,
  clearCodeWatchDirectoryLimitError,
  closeEditorTab,
  codeFileName,
  codeLanguage,
  codeModelKey,
  codeModelTransition,
  codePanelId,
  codeParentDirectory,
  codeWatchDirectoryLimitError,
  disposeCodeModels,
  enqueueCodeOpenRequest,
  isEditorValuePersisted,
  isCodePath,
  openEditorTab,
  renameEditorTab,
  updateDirtyCodeWindows,
} from './code-editor-model'

describe('Code editor model', () => {
  test('accepts only clean absolute guest paths', () => {
    expect(isCodePath('/workspace/src/main.rs')).toBe(true)
    expect(isCodePath('workspace/src/main.rs')).toBe(false)
    expect(isCodePath('/workspace/src\nmain.rs')).toBe(false)
  })

  test('opens each file once and selects the nearest tab after close', () => {
    const first = openEditorTab([], '/workspace/a.ts')
    const second = openEditorTab(first, '/workspace/b.ts')
    expect(openEditorTab(second, '/workspace/a.ts')).toEqual(second)
    expect(closeEditorTab(second, '/workspace/a.ts', '/workspace/a.ts')).toEqual({
      tabs: [{ path: '/workspace/b.ts', dirty: false, state: 'loading', error: '' }],
      activePath: '/workspace/b.ts',
    })
    expect(closeEditorTab(second, '/workspace/b.ts', '/workspace/a.ts').activePath).toBe('/workspace/b.ts')
  })

  test('derives readable names and Monaco language identifiers', () => {
    expect(codeFileName('/workspace/src/main.ts')).toBe('main.ts')
    expect(codeLanguage('/workspace/src/main.tsx')).toBe('typescript')
    expect(codeLanguage('/workspace/README')).toBe('plaintext')
    expect(codeParentDirectory('/workspace/src/main.ts')).toBe('/workspace/src')
  })

  test('moves an open tab after an external rename without changing its editor state', () => {
    const tabs = [{ path: '/workspace/a.ts', dirty: true, state: 'error' as const, error: 'conflict' }]
    expect(renameEditorTab(tabs, '/workspace/a.ts', '/workspace/a.ts', '/workspace/b.ts')).toEqual({
      tabs: [{ ...tabs[0], path: '/workspace/b.ts' }],
      activePath: '/workspace/b.ts',
    })
  })

  test('does not treat a reverted value as persisted while an earlier save is still pending', () => {
    expect(isEditorValuePersisted('original', 'original', false)).toBe(true)
    expect(isEditorValuePersisted('original', 'original', true)).toBe(false)
    expect(isEditorValuePersisted('changed', 'original', false)).toBe(false)
    expect(isEditorValuePersisted('', undefined, false)).toBe(false)
  })

  test('blocks queued writes after a conflict and clears only the recoverable directory-limit error', () => {
    const path = '/workspace/main.rs'
    expect(canStartEditorSave(path, new Set([path]), new Set())).toBe(false)
    expect(canStartEditorSave(path, new Set(), new Set([path]))).toBe(false)
    expect(canStartEditorSave(path, new Set(), new Set())).toBe(true)

    expect(clearCodeWatchDirectoryLimitError(codeWatchDirectoryLimitError())).toBe('')
    expect(clearCodeWatchDirectoryLimitError('Monaco failed to initialize')).toBe('Monaco failed to initialize')
  })

  test('preserves every open request received before Monaco is ready', () => {
    const first = { path: '/workspace/first.ts', requestId: 1 }
    const second = { path: '/workspace/second.ts', requestId: 2 }
    const queued = enqueueCodeOpenRequest(enqueueCodeOpenRequest([], first), second)

    expect(queued).toEqual([first, second])
    expect(enqueueCodeOpenRequest(queued, first)).toBe(queued)
  })

  test('tracks dirty state independently for every Code window', () => {
    const first = updateDirtyCodeWindows(new Set(), 'code-1', true)
    const both = updateDirtyCodeWindows(first, 'code-2', true)
    const secondOnly = updateDirtyCodeWindows(both, 'code-1', false)

    expect([...both]).toEqual(['code-1', 'code-2'])
    expect([...secondOnly]).toEqual(['code-2'])
    expect(updateDirtyCodeWindows(secondOnly, 'code-2', true)).toBe(secondOnly)
  })

  test('scopes models and accessibility panels to their owning instance', () => {
    expect(codeModelKey('agent-a', '/workspace/main.ts')).not.toBe(codeModelKey('agent-b', '/workspace/main.ts'))
    expect(codePanelId('editor-a')).not.toBe(codePanelId('editor-b'))
  })

  test('detaches stale content while an active uncached file loads', () => {
    const cachedModel = { id: 'cached' }
    expect(codeModelTransition('/workspace/new.ts', '/workspace/new.ts', undefined)).toEqual({ type: 'detach' })
    expect(codeModelTransition('/workspace/current.ts', '/workspace/background.ts', undefined)).toEqual({
      type: 'unchanged',
    })
    expect(codeModelTransition('/workspace/current.ts', '/workspace/current.ts', cachedModel)).toEqual({
      type: 'show',
      model: cachedModel,
    })
    expect(codeModelTransition('/workspace/current.ts', '/workspace/current.ts', cachedModel, true)).toEqual({
      type: 'refresh',
      model: cachedModel,
    })
  })

  test('disposes every cached model when an agent session changes', () => {
    const disposed: string[] = []
    const models = new Map([
      ['first', { dispose: () => disposed.push('first') }],
      ['second', { dispose: () => disposed.push('second') }],
    ])

    disposeCodeModels(models)

    expect(disposed).toEqual(['first', 'second'])
    expect(models.size).toBe(0)
  })
})
