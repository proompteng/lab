import { expect, test } from 'bun:test'
import { isCodexDiagnosticLogWarning } from './codex-diagnostics'
import { codexEventShouldRender } from '../../components/tengri/codex-events'

test('routes only the exact unscoped native logging diagnostic out of conversation rendering', () => {
  const event = {
    sequence: 7,
    kind: 'warning' as const,
    method: 'warning',
    threadId: '',
    turnId: '',
    itemId: '',
    approvalId: '',
    rawJson: '{}',
    text: "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics.",
  }
  expect(isCodexDiagnosticLogWarning(event)).toBe(true)
  expect(codexEventShouldRender(event, 'thread-cat', new Set(), 0)).toBe(false)
  for (const other of [
    { ...event, text: 'Provider connection interrupted' },
    { ...event, method: 'tengri/replayWarning' },
    { ...event, threadId: 'thread-cat' },
    { ...event, kind: 'error' as const },
    { ...event, kind: 'assistant-text' as const },
  ]) {
    expect(isCodexDiagnosticLogWarning(other)).toBe(false)
    expect(codexEventShouldRender(other, 'thread-cat', new Set(), 0)).toBe(true)
  }
})
