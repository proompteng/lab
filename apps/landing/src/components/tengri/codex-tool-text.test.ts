import { expect, test } from 'bun:test'
import { codexToolText } from './codex-tool-text'

test('renders ANSI output without cursor, color, or OSC controls', () => {
  expect(codexToolText('\u001b[1A\u001b[2K\u001b[2m[WebServer]\u001b[0m ready\r\nnext')).toBe('[WebServer] ready\nnext')
  expect(codexToolText('\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\')).toBe('link')
})

test('decodes complete JSON string output once while preserving literal code and malformed strings', () => {
  expect(codexToolText(JSON.stringify('First line\nSecond line'))).toBe('First line\nSecond line')
  expect(codexToolText('const text = "line\\nnext"')).toBe('const text = "line\\nnext"')
  expect(codexToolText('"truncated\\n')).toBe('"truncated\\n')
})
