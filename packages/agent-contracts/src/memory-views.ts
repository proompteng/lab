import type { AgentsMemoryNoteRecord, AgentsMemoryNoteSummary, AgentsListMemoryNotesResult } from './memory-client'
import { clampUtf8 } from './swarm-analysis'

type SummaryInput = Pick<
  AgentsMemoryNoteRecord,
  'id' | 'summary' | 'metadata' | 'createdAt' | 'retiredAt' | 'replacementId'
>

export const summarizeMemoryNote = (note: SummaryInput): AgentsMemoryNoteSummary => {
  const preview = clampUtf8((note.summary ?? '').replace(/\p{Cc}/gu, ' '), 160)
  const { repository, commit, noteModel } = note.metadata
  return {
    id: note.id,
    summary: preview.value,
    summaryTruncated: preview.truncated,
    createdAt: note.createdAt,
    repository:
      typeof repository === 'string' && repository.length <= 200 && /^[\w.-]+\/[\w.-]+$/.test(repository)
        ? repository
        : null,
    commit: typeof commit === 'string' && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null,
    model: typeof noteModel === 'string' ? clampUtf8(noteModel, 64).value : null,
    retiredAt: note.retiredAt,
    replacementId: note.replacementId,
  }
}

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

export const fitMemoryNotesPage = (
  page: AgentsListMemoryNotesResult,
  maxBytes: number,
  measure: (value: AgentsListMemoryNotesResult) => number = jsonBytes,
) => {
  while (measure(page) > maxBytes) {
    if (page.memories.length > 1) {
      page.memories.pop()
      page.nextCursor = page.memories.at(-1)?.id ?? null
    } else {
      const note = page.memories[0]
      if (!note?.summary) throw new Error('Memory page metadata exceeds the output budget.')
      note.summary = clampUtf8(note.summary, Math.floor(new TextEncoder().encode(note.summary).byteLength / 2)).value
      note.summaryTruncated = true
    }
  }
  return page
}

export type AgentsMemoryNoteRead = {
  ok: true
  memory: AgentsMemoryNoteSummary & { retirementReason: string | null; retirementReasonTruncated: boolean }
  content: string
  offset: number
  nextOffset: number | null
}

export const readMemoryNote = (
  note: AgentsMemoryNoteRecord,
  offset = 0,
  maxBytes = 20_000,
  measure: (value: AgentsMemoryNoteRead) => number = jsonBytes,
): AgentsMemoryNoteRead => {
  const characters = Array.from(note.content)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > characters.length)
    throw new Error('offset is outside the note. Use nextOffset from the previous response.')
  const remaining = characters.slice(offset).join('')
  const result: AgentsMemoryNoteRead = {
    ok: true,
    memory: { ...summarizeMemoryNote(note), retirementReason: note.retirementReason, retirementReasonTruncated: false },
    content: characters[offset] ?? '',
    offset,
    nextOffset: offset < characters.length ? offset + 1 : null,
  }
  while (measure(result) > maxBytes) {
    if (result.memory.retirementReason) {
      result.memory.retirementReason = clampUtf8(
        result.memory.retirementReason,
        Math.floor(new TextEncoder().encode(result.memory.retirementReason).byteLength / 2),
      ).value
      result.memory.retirementReasonTruncated = true
    } else if (result.memory.summary) {
      result.memory.summary = clampUtf8(
        result.memory.summary,
        Math.floor(new TextEncoder().encode(result.memory.summary).byteLength / 2),
      ).value
      result.memory.summaryTruncated = true
    } else throw new Error('Memory metadata exceeds the output budget.')
  }
  let bytes = Math.min(8_000, maxBytes)
  while (true) {
    result.content = clampUtf8(remaining, bytes).value || characters[offset] || ''
    const next = offset + Array.from(result.content).length
    result.nextOffset = next < characters.length ? next : null
    if (measure(result) <= maxBytes) return result
    bytes = Math.floor(bytes / 2)
  }
}
