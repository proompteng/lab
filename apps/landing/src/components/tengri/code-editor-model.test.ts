import { describe, expect, test } from 'bun:test'

import {
  closeEditorTab,
  codeFileName,
  codeLanguage,
  codeModelKey,
  codeModelTransition,
  codePanelId,
  disposeCodeModels,
  enqueueCodeOpenRequest,
  isCodePath,
  openEditorTab,
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
      tabs: [{ path: '/workspace/b.ts', state: 'loading', error: '' }],
      activePath: '/workspace/b.ts',
    })
    expect(closeEditorTab(second, '/workspace/b.ts', '/workspace/a.ts').activePath).toBe('/workspace/b.ts')
  })

  test('derives readable names and Monaco language identifiers', () => {
    expect(codeFileName('/workspace/src/main.ts')).toBe('main.ts')
    expect(codeLanguage('/workspace/src/main.tsx')).toBe('typescript')
    expect(codeLanguage('/workspace/README')).toBe('plaintext')
  })

  test('preserves every open request received before Monaco is ready', () => {
    const first = { path: '/workspace/first.ts', requestId: 1 }
    const second = { path: '/workspace/second.ts', requestId: 2 }
    const queued = enqueueCodeOpenRequest(enqueueCodeOpenRequest([], first), second)

    expect(queued).toEqual([first, second])
    expect(enqueueCodeOpenRequest(queued, first)).toBe(queued)
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
