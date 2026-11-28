import type { TengriCodexEvent } from '@/lib/tengri/types'

type HistoryRecord = Record<string, unknown>

export function codexHistory(turns: HistoryRecord[], metadata: HistoryRecord = {}) {
  return JSON.stringify({ thread: { ...metadata, turns } })
}

export function agentMessage(id: string, text: string) {
  return { id, type: 'agentMessage', text }
}

export function completedTurn(id: string, items: HistoryRecord[] = []) {
  return { id, status: 'completed', items }
}

export function runningTurn(id: string, items: HistoryRecord[] = []) {
  return { id, status: 'inProgress', items }
}

export function codexEvent(overrides: Partial<TengriCodexEvent> = {}): TengriCodexEvent {
  return {
    sequence: 1,
    kind: 'assistant-text',
    method: 'item/completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: '',
    text: '',
    approvalId: '',
    rawJson: '{}',
    ...overrides,
  }
}

export function codexParams(params: Record<string, unknown>) {
  return JSON.stringify({ params })
}
