import { describe, expect, it, vi } from 'vitest'

import { postRunComplete } from './run-complete'

describe('/api/codex/run-complete', () => {
  it('ingests through Agents before running Jangar domain completion logic', async () => {
    const calls: string[] = []
    const submitCodexCallback = vi.fn(async () => {
      calls.push('agents')
      return { ok: true as const, status: 202, body: { ok: true, callback: { kind: 'run-complete' } } }
    })
    const handleRunComplete = vi.fn(async () => {
      calls.push('jangar')
      return { id: 'run-1' }
    })

    const response = await postRunComplete(
      new Request('http://jangar.test/api/codex/run-complete', {
        body: JSON.stringify({ workflowName: 'workflow-1', status: { phase: 'Succeeded' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { handleRunComplete, submitCodexCallback },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      agents: { ok: true, callback: { kind: 'run-complete' } },
      run: { id: 'run-1' },
    })
    expect(submitCodexCallback).toHaveBeenCalledWith({
      kind: 'run-complete',
      payload: { workflowName: 'workflow-1', status: { phase: 'Succeeded' } },
    })
    expect(handleRunComplete).toHaveBeenCalledWith({ workflowName: 'workflow-1', status: { phase: 'Succeeded' } })
    expect(calls).toEqual(['agents', 'jangar'])
  })

  it('does not run Jangar domain completion logic when Agents ingestion fails', async () => {
    const handleRunComplete = vi.fn(async () => ({ id: 'run-1' }))
    const response = await postRunComplete(
      new Request('http://jangar.test/api/codex/run-complete', {
        body: JSON.stringify({ workflowName: 'workflow-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      {
        handleRunComplete,
        submitCodexCallback: vi.fn(async () => ({
          ok: false as const,
          status: 503,
          body: { ok: false, error: 'agents unavailable' },
          error: 'agents unavailable',
        })),
      },
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'agents unavailable',
      agentsStatus: 503,
    })
    expect(handleRunComplete).not.toHaveBeenCalled()
  })
})
