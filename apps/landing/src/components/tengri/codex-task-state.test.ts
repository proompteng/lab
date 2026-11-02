import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { TengriCodexRun } from '@/lib/tengri/codex-run'
import { codexRunCanStop, codexTaskState, elapsedSinceSubmission } from './codex-task-state'
import { CodexTaskStatus } from './codex-task-status'

const run: TengriCodexRun = {
  agentId: 'workspace-one',
  runId: '11111111-1111-4111-8111-111111111111',
  threadId: 'conversation-one',
  state: { phase: 'running', turnId: 'turn-one' },
}

test('known-run stop is independent of list recovery but rejects other identities and terminal runs', () => {
  expect(codexRunCanStop(run, run)).toBe(true)
  expect(codexRunCanStop(null, run)).toBe(false)
  for (const key of ['agentId', 'runId', 'threadId'] as const)
    expect(codexRunCanStop(run, { ...run, [key]: 'other' })).toBe(false)
  expect(codexRunCanStop({ ...run, state: { phase: 'succeeded', turnId: 'turn-one' } }, run)).toBe(false)
  // A new login can refresh expired cancellation authority; a recorded Stop is not terminal.
  expect(
    codexRunCanStop({ ...run, state: { phase: 'cancelling', turnId: 'turn-one', reason: 'Stop pending' } }, run),
  ).toBe(true)
})

test('task reasons distinguish paused cancellation, cleanup and uncertain outcomes', () => {
  expect(
    codexTaskState({ phase: 'cancelling', turnId: 'turn-one', reason: 'The workspace is paused' }).description,
  ).toContain('Resume the workspace')
  expect(
    codexTaskState({ phase: 'cancelling', turnId: 'turn-one', reason: 'waiting for command cleanup receipt' })
      .description,
  ).toContain('commands')
  expect(
    codexTaskState({ phase: 'recovering', turnId: 'turn-one', reason: 'waiting for the recorded turn outcome' })
      .description,
  ).toContain('will not be sent again')
  expect(codexTaskState({ phase: 'needs_reconciliation', reason: 'dispatch outcome is uncertain' }).label).toBe(
    'Review needed',
  )
})

test('degraded observation shows safe stop and last checked without inventing a recovered start or progress time', () => {
  const html = renderToString(
    createElement(CodexTaskStatus, {
      run,
      observation: { lastCheckedAtMs: 1_800_000_000_000 },
      degraded: true,
      checking: false,
      canStop: true,
      stopping: false,
      onStop: () => undefined,
      onRetry: () => undefined,
    }),
  )
  expect(html).toContain('Status unavailable')
  expect(html).toContain('Existing work may still be running')
  expect(html).toContain('Stop task')
  expect(html).toContain('Retry status')
  expect(html).toContain('Last checked')
  expect(html).not.toContain('Since submitted')
  expect(html).not.toContain('Last update received')
})

test('elapsed submission time is bounded and never negative after clock movement', () => {
  expect(elapsedSinceSubmission(1000, 0)).toBe('0s')
  expect(elapsedSinceSubmission(1000, 62_000)).toBe('1m 1s')
  expect(elapsedSinceSubmission(1000, 3_661_000)).toBe('1h 1m')
})

test('malformed observation dates cannot crash the task panel or invent timing', () => {
  const html = renderToString(
    createElement(CodexTaskStatus, {
      run,
      observation: { submittedAtMs: 1e30, lastCheckedAtMs: Infinity, lastUpdateReceivedAtMs: NaN },
      degraded: false,
      checking: false,
      canStop: true,
      stopping: false,
      onStop: () => undefined,
      onRetry: () => undefined,
    }),
  )
  expect(html).toContain('Working')
  expect(html).not.toContain('Since submitted')
  expect(html).not.toContain('<time')
})
