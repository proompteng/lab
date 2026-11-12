import { describe, expect, it } from 'vitest'
import { fitMemoryNotesPage, readMemoryNote, summarizeMemoryNote } from './memory-views'
import { parseListMemoryNotesInput, type AgentsMemoryNoteRecord } from './memory-client'

const note = (content = 'A complete note.'): AgentsMemoryNoteRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  namespace: 'engineering',
  content,
  summary: '"'.repeat(500),
  tags: ['test'],
  metadata: { repository: 'proompteng/lab', commit: 'a'.repeat(40), noteModel: 'qwen38-flamingo' },
  createdAt: '2026-11-11T00:00:00.000Z',
  retiredAt: null,
  retirementReason: null,
  replacementId: null,
})

describe('memory reading and browsing', () => {
  it('reads complete Unicode and escaped content without repetition or missing characters', () => {
    const original = note('Line\n🦊漢字\\"\u0000'.repeat(1500))
    let offset = 0
    let combined = ''
    let calls = 0
    while (true) {
      const page = readMemoryNote(original, offset, 4096)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      expect(page.content).not.toContain('\ufffd')
      combined += page.content
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
      if (++calls > 100) throw new Error('Reading failed to make progress')
    }
    expect(combined).toBe(original.content)
    expect(original.summary).toBe('"'.repeat(500))
  })

  it('preserves retirement status and marks a reason shortened to fit the output budget', () => {
    const original = {
      ...note('historical evidence'),
      retiredAt: '2026-11-12T00:00:00Z',
      retirementReason: '\u0000'.repeat(1000),
    }
    const result = readMemoryNote(original, 0, 4096)
    expect(result.memory.retiredAt).toBe(original.retiredAt)
    expect(result.memory.retirementReasonTruncated).toBe(true)
    expect(result.content.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  })

  it('resumes a budget-limited list after its last visible note', () => {
    const memories = Array.from({ length: 20 }, (_, index) => ({ ...summarizeMemoryNote(note()), id: `note-${index}` }))
    const result = fitMemoryNotesPage({ ok: true, memories, nextCursor: null }, 4096)
    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.memories.length).toBeLessThan(20)
    expect(result.nextCursor).toBe(result.memories.at(-1)?.id)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  })

  it('rejects invalid offsets and cursors with actionable errors', () => {
    expect(() => readMemoryNote(note(), -1)).toThrow('offset')
    expect(() => readMemoryNote(note(), 1000)).toThrow('offset')
    expect(parseListMemoryNotesInput({ cursor: 'not-a-note' }).ok).toBe(false)
  })
})
