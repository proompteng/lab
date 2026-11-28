import { describe, expect, test } from 'bun:test'
import { parseWorkspaceFileLink } from './workspace-file-link-model'

describe('workspace file links', () => {
  test('opens the workspace root and canonicalizes folder links', () => {
    expect(parseWorkspaceFileLink('/workspace')).toEqual({ path: '/workspace', line: undefined, column: undefined })
    expect(parseWorkspaceFileLink('/workspace/src/')).toEqual({
      path: '/workspace/src',
      line: undefined,
      column: undefined,
    })
    expect(parseWorkspaceFileLink('/workspace/')).toEqual({ path: '/workspace', line: undefined, column: undefined })
  })
  test('preserves the canonical path used by signed file requests', () => {
    const file = parseWorkspaceFileLink('/workspace/lab/README.md:2')
    expect(file).not.toBeNull()
    expect(file!.path).toBe('/workspace/lab/README.md')
  })

  test('preserves absolute guest paths and preserves locations', () => {
    expect(parseWorkspaceFileLink('/workspace/lab/docs/tengri/ofz-implementation-status.md:177')).toEqual({
      path: '/workspace/lab/docs/tengri/ofz-implementation-status.md',
      line: 177,
      column: undefined,
    })
    expect(parseWorkspaceFileLink('/workspace/a%20b.ts:12:3')).toEqual({
      path: '/workspace/a b.ts',
      line: 12,
      column: 3,
    })
    expect(parseWorkspaceFileLink('/workspace/a.ts#L12C3')).toEqual({ path: '/workspace/a.ts', line: 12, column: 3 })
    expect(parseWorkspaceFileLink('/workspace/README.md')).toEqual({
      path: '/workspace/README.md',
      line: undefined,
      column: undefined,
    })
  })

  test('resolves links within rendered workspace documents', () => {
    expect(parseWorkspaceFileLink('operations.md:12', '/workspace/lab/docs/tengri/status.md')).toEqual({
      path: '/workspace/lab/docs/tengri/operations.md',
      line: 12,
      column: undefined,
    })
    expect(parseWorkspaceFileLink('../../../../etc/passwd', '/workspace/lab/docs/tengri/status.md')).toBeNull()
  })

  test('rejects web URLs, unsafe paths and invalid locations', () => {
    for (const href of [
      'https://example.com/workspace/a.ts:2',
      '//example.com/workspace/a.ts',
      '/etc/passwd',
      '/workspace/../secret',
      '/workspace/%2e%2e/secret',
      '/workspace/a%00.ts',
      '/workspace/a%0a.ts',
      '/workspace/a\\b.ts',
      '/workspace/%zz',
      '/workspace/a.ts:0',
      '/workspace/a.ts:1:0',
      '/workspace/a.ts:9007199254740992',
      '/workspace/a.ts?download=1',
      'javascript:alert(1)',
    ])
      expect(parseWorkspaceFileLink(href)).toBeNull()
  })
})
