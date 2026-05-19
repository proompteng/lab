import { describe, expect, it } from 'vitest'

import { postNotify } from './notify'

describe('/api/codex/notify', () => {
  it('rejects the removed Jangar callback ingress with the Agents replacement path', async () => {
    const response = await postNotify(
      new Request('http://jangar.test/api/codex/notify', {
        body: JSON.stringify({ workflowName: 'workflow-1', last_assistant_message: 'opened PR' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Jangar no longer accepts Codex notify callbacks. Submit to Agents /api/agents/codex/notify.',
      replacement: '/api/agents/codex/notify',
    })
  })
})
