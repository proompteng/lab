import { describe, expect, it, vi } from 'vitest'

import { postNotify } from './notify'

describe('/api/codex/notify', () => {
  it('ingests through Agents before running Jangar domain notify logic', async () => {
    const calls: string[] = []
    const submitCodexCallback = vi.fn(async () => {
      calls.push('agents')
      return { ok: true as const, status: 202, body: { ok: true, callback: { kind: 'notify' } } }
    })
    const handleNotify = vi.fn(async () => {
      calls.push('jangar')
      return { id: 'run-1' }
    })

    const response = await postNotify(
      new Request('http://jangar.test/api/codex/notify', {
        body: JSON.stringify({ workflowName: 'workflow-1', last_assistant_message: 'opened PR' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { handleNotify, submitCodexCallback },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      agents: { ok: true, callback: { kind: 'notify' } },
      run: { id: 'run-1' },
    })
    expect(submitCodexCallback).toHaveBeenCalledWith({
      kind: 'notify',
      payload: { workflowName: 'workflow-1', last_assistant_message: 'opened PR' },
    })
    expect(handleNotify).toHaveBeenCalledWith({ workflowName: 'workflow-1', last_assistant_message: 'opened PR' })
    expect(calls).toEqual(['agents', 'jangar'])
  })

  it('forwards AgentRun-native notify payloads without requiring workflow aliases', async () => {
    const submitCodexCallback = vi.fn(async () => ({
      ok: true as const,
      status: 202,
      body: { ok: true, callback: { kind: 'notify' } },
    }))
    const handleNotify = vi.fn(async () => ({ id: 'run-1' }))
    const payload = {
      agent_run_id: 'run-1',
      agent_run_name: 'agentrun-1',
      agent_run_namespace: 'agents',
      last_assistant_message: 'opened PR',
    }

    const response = await postNotify(
      new Request('http://jangar.test/api/codex/notify', {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { handleNotify, submitCodexCallback },
    )

    expect(response.status).toBe(200)
    expect(submitCodexCallback).toHaveBeenCalledWith({ kind: 'notify', payload })
    expect(handleNotify).toHaveBeenCalledWith(payload)
  })
})
