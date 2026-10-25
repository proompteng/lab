import { describe, expect, it } from 'bun:test'
import { parseCodexResponse } from '../codex'

describe('parseCodexResponse', () => {
  it('parses fenced JSON', () => {
    const input = '```json\n{"summary":"Sum","text":"Body","acceptanceCriteria":["A"],"labels":["x"]}\n```'
    const spec = parseCodexResponse(input)
    expect(spec.summary).toBe('Sum')
    expect(spec.text).toBe('Body')
    expect(spec.acceptanceCriteria).toEqual(['A'])
    expect(spec.labels).toEqual(['x'])
  })
})
