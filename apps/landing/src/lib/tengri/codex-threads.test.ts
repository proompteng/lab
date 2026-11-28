import { describe, expect, test } from 'bun:test'
import { codexThreadTitle, parseCodexThreadPage } from './codex-threads'

describe('native chat index', () => {
  test('uses native names, falls back to the first prompt, and preserves opaque cursors', () => {
    expect(
      parseCodexThreadPage(
        JSON.stringify({
          data: [
            { id: 'named', name: '  Named chat ', preview: 'First prompt', updatedAt: 20, turns: [] },
            { id: 'preview', name: null, preview: 'First\n  prompt', updatedAt: 10 },
          ],
          nextCursor: 'opaque:next/page',
        }),
      ),
    ).toEqual({
      threads: [
        { id: 'named', title: 'Named chat', updatedAt: 20_000 },
        { id: 'preview', title: 'First prompt', updatedAt: 10_000 },
      ],
      nextCursor: 'opaque:next/page',
    })
  })
  test('rejects invalid pages and duplicate identities instead of inventing sessions', () => {
    for (const value of [
      null,
      { data: [{}] },
      { data: [{ id: 'bad', preview: '', updatedAt: -1 }] },
      { data: Array.from({ length: 2 }, () => ({ id: 'duplicate', preview: '', updatedAt: 1 })) },
    ])
      expect(() => parseCodexThreadPage(JSON.stringify(value))).toThrow()
  })
  test('keeps empty and long titles compact', () => {
    expect(codexThreadTitle(' ')).toBe('New chat')
    expect(codexThreadTitle('A'.repeat(100))).toBe(`${'A'.repeat(45)}…`)
  })
})
