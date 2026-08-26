import { describe, expect, test } from 'bun:test'

import {
  closeEditorTab,
  codeFileName,
  codeLanguage,
  codeParentDirectory,
  isEditorValuePersisted,
  isCodePath,
  openEditorTab,
  renameEditorTab,
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
})
