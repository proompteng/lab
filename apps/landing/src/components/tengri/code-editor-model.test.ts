import { describe, expect, test } from 'bun:test'
import { enqueueCodeOpenRequest, isCodePath, updateDirtyCodeWindows } from './code-editor-model'

describe('Code workbench integration', () => {
  test('accepts only clean absolute guest paths', () => {
    expect(isCodePath('/workspace/src/main.rs')).toBe(true)
    expect(isCodePath('workspace/src/main.rs')).toBe(false)
    expect(isCodePath('/workspace/src\nmain.rs')).toBe(false)
  })

  test('preserves every open request received before VS Code is ready', () => {
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
})
