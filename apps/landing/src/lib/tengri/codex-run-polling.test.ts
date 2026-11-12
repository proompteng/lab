import { expect, test } from 'bun:test'

import { codexRunCanStop, recoveredCodexRun, type TengriCodexRun } from './codex-run'

const run: TengriCodexRun = {
  runId: '11111111-1111-4111-8111-111111111111',
  agentId: 'agent-one',
  threadId: 'thread-one',
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

test('the workspace poll supplies the selected run without another status request', async () => {
  let statusRequests = 0
  const fetchStatus = async () => {
    statusRequests += 1
    return run
  }
  for (let poll = 0; poll < 10; poll += 1) {
    const current = recoveredCodexRun([run], true, run.agentId, run.threadId, run.runId) ?? (await fetchStatus())
    expect(current).toBe(run)
  }
  expect(statusRequests).toBe(0)
})

test('failed recovery and a run leaving the active set require an authoritative status fetch', () => {
  expect(recoveredCodexRun([run], false, run.agentId, run.threadId, run.runId)).toBeUndefined()
  expect(recoveredCodexRun([], true, run.agentId, run.threadId, run.runId)).toBeUndefined()
})

test('a snapshot from another workspace, conversation, or run is never reused', () => {
  expect(recoveredCodexRun([run], true, 'other-agent', run.threadId, run.runId)).toBeUndefined()
  expect(recoveredCodexRun([run], true, run.agentId, 'other-thread', run.runId)).toBeUndefined()
  expect(recoveredCodexRun([run], true, run.agentId, run.threadId, 'other-run')).toBeUndefined()
})
