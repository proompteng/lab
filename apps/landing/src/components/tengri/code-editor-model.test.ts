import { describe, expect, test } from 'bun:test'

import { closeEditorTab, codeFileName, codeLanguage, isCodePath, openEditorTab } from './code-editor-model'

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
})
