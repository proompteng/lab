import type { TengriCodexThread } from './types'

export type CodexHistoryPage = {
  type: 'page'
  part: 'thread' | 'items' | 'turns'
  rawJson: string
  eventSequence: number
}

const MAX_RECORD_CHARACTERS = 32 * 1024 * 1024
const MAX_HISTORY_PAGES = 256
const PAGE_SIZE = 100

type JsonRecord = Record<string, unknown>

export async function readCodexHistory(
  response: Response,
  threadId: string,
  signal: AbortSignal | undefined,
  failure: (record: JsonRecord) => Error,
): Promise<TengriCodexThread> {
  if (!response.headers.get('Content-Type')?.startsWith('application/x-ndjson') || !response.body) {
    throw new Error('Codex conversation recovery did not return a history stream')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const history = new CodexHistory(threadId)
  let pending = ''
  let completed = false
  const abort = () => void reader.cancel(signal?.reason).catch(() => {})
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      pending += decoder.decode(value, { stream: !done })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        if (newline > MAX_RECORD_CHARACTERS) throw invalidHistory('history page is too large')
        const record = object(JSON.parse(pending.slice(0, newline)))
        pending = pending.slice(newline + 1)
        if (completed) throw invalidHistory('data after completion')
        if (record.type === 'error') throw failure(record)
        if (record.type === 'complete') completed = true
        else history.include(record)
        newline = pending.indexOf('\n')
      }
      if (pending.length > MAX_RECORD_CHARACTERS) throw invalidHistory('history page is too large')
      if (done) break
    }
    if (pending.length || !completed) throw invalidHistory('history stream ended before completion')
    return history.finish()
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

class CodexHistory {
  private snapshot?: JsonRecord
  private baseline = 0
  private sequence = 0
  private pages = 0
  private mode?: 'paginated' | 'legacy'
  private part?: CodexHistoryPage['part']
  private nextCursor: string | null = null
  private readonly cursors = new Set<string>()
  private readonly items = new Map<string, JsonRecord[]>()
  private readonly itemSequences = new Map<string, number>()
  private readonly turns: JsonRecord[] = []
  private readonly turnIds = new Set<string>()

  constructor(private readonly threadId: string) {}

  include(record: JsonRecord) {
    if (record.type !== 'page' || typeof record.rawJson !== 'string') throw invalidHistory('invalid history record')
    const sequence = record.eventSequence
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < this.sequence) {
      throw invalidHistory('invalid event cursor')
    }
    if (++this.pages > MAX_HISTORY_PAGES) throw invalidHistory('too many history pages')
    this.sequence = sequence
    const result = object(JSON.parse(record.rawJson))
    if (record.part === 'thread') {
      if (this.snapshot) throw invalidHistory('duplicate thread metadata')
      const thread = object(result.thread)
      if (thread.id !== this.threadId || !Array.isArray(thread.turns)) throw invalidHistory('invalid thread metadata')
      if (thread.historyMode !== 'paginated' && thread.historyMode !== 'legacy')
        throw invalidHistory('unknown history mode')
      if (thread.historyMode === 'paginated' && thread.turns.length) throw invalidHistory('unexpected hydrated thread')
      this.snapshot = result
      this.baseline = sequence
      this.mode = thread.historyMode
      this.part = 'thread'
      return
    }
    if (!this.snapshot || this.mode !== 'paginated') throw invalidHistory('unexpected history page')
    if (record.part !== 'items' && record.part !== 'turns') throw invalidHistory('unknown history part')
    if (record.part !== this.part) {
      if (this.nextCursor !== null || (record.part === 'items' ? this.part !== 'thread' : this.part !== 'items')) {
        throw invalidHistory('history pages arrived out of order')
      }
      this.part = record.part
      this.cursors.clear()
    } else if (this.nextCursor === null) throw invalidHistory('page after final cursor')
    if (!Array.isArray(result.data) || result.data.length > PAGE_SIZE) throw invalidHistory('invalid history page')
    const cursor = result.nextCursor
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || this.cursors.has(cursor))) {
      throw invalidHistory('invalid history cursor')
    }
    this.nextCursor = cursor
    if (cursor !== null) this.cursors.add(cursor)
    for (const value of result.data) {
      const entry = object(value)
      if (record.part === 'items') {
        const turnId = identity(entry.turnId)
        const item = object(entry.item)
        const itemId = identity(item.id)
        if (this.itemSequences.has(itemId)) throw invalidHistory('duplicate item')
        this.itemSequences.set(itemId, sequence)
        const items = this.items.get(turnId) ?? []
        items.push(item)
        this.items.set(turnId, items)
      } else {
        const turnId = identity(entry.id)
        if (this.turnIds.has(turnId)) throw invalidHistory('duplicate turn')
        this.turnIds.add(turnId)
        if (
          typeof entry.status !== 'string' ||
          !['completed', 'interrupted', 'failed', 'inProgress'].includes(entry.status)
        ) {
          throw invalidHistory('invalid turn status')
        }
        if (!Array.isArray(entry.items) || entry.items.length || entry.itemsView !== 'notLoaded') {
          throw invalidHistory('unexpected hydrated turn')
        }
        this.turns.push({ ...entry, items: this.items.get(turnId) ?? [], itemsView: 'full' })
        this.items.delete(turnId)
      }
    }
  }

  finish(): TengriCodexThread {
    if (!this.snapshot) throw invalidHistory('missing thread metadata')
    if (this.mode === 'paginated') {
      if (this.part !== 'turns' || this.nextCursor !== null || this.items.size)
        throw invalidHistory('incomplete history')
      object(this.snapshot.thread).turns = this.turns
    }
    return {
      id: this.threadId,
      rawJson: JSON.stringify(this.snapshot),
      eventSequence: this.baseline,
      itemEventSequences: Object.fromEntries(this.itemSequences),
    }
  }
}

function object(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidHistory('expected an object')
  return value as JsonRecord
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalidHistory('missing history identity')
  return value
}

function invalidHistory(reason: string) {
  return new Error(`Codex conversation recovery returned invalid history: ${reason}`)
}
