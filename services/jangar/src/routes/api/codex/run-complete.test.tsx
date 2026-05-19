import { describe, expect, it } from 'vitest'

import { postRunComplete } from './run-complete'

describe('/api/codex/run-complete', () => {
  it('rejects the removed Jangar callback ingress with the Agents replacement path', async () => {
    const response = await postRunComplete(
      new Request('http://jangar.test/api/codex/run-complete', {
        body: JSON.stringify({ workflowName: 'workflow-1', status: { phase: 'Succeeded' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Jangar no longer accepts Codex run-complete callbacks. Submit to Agents /api/agents/codex/run-complete.',
      replacement: '/api/agents/codex/run-complete',
    })
  })
})
