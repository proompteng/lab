import { describe, expect, it, vi } from 'vitest'

import { postControlPlaneAgentRun } from '~/routes/api/control-plane/agent-runs'

describe('control-plane AgentRun BFF', () => {
  it('submits AgentRun creation through the Agents service client', async () => {
    const submitAgentRun = vi.fn(async () => ({
      ok: true as const,
      status: 201,
      body: {
        ok: true,
        resource: { kind: 'AgentRun', metadata: { name: 'demo-run' } },
      },
    }))

    const response = await postControlPlaneAgentRun(
      new Request('http://jangar.test/api/control-plane/agent-runs?dryRun=true', {
        body: JSON.stringify({ agentRef: { name: 'demo-agent' } }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'delivery-1',
        },
        method: 'POST',
      }),
      { submitAgentRun },
    )

    await expect(response.json()).resolves.toEqual({
      ok: true,
      resource: { kind: 'AgentRun', metadata: { name: 'demo-run' } },
    })
    expect(response.status).toBe(201)
    expect(submitAgentRun).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      dryRun: 'true',
      payload: { agentRef: { name: 'demo-agent' } },
    })
  })

  it('rejects missing idempotency keys before calling Agents', async () => {
    const submitAgentRun = vi.fn()
    const response = await postControlPlaneAgentRun(
      new Request('http://jangar.test/api/control-plane/agent-runs', {
        body: JSON.stringify({ agentRef: { name: 'demo-agent' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { submitAgentRun },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'idempotency-key header is required',
    })
    expect(submitAgentRun).not.toHaveBeenCalled()
  })
})
