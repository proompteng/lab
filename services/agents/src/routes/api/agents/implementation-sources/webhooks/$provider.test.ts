import { afterEach, describe, expect, it, vi } from 'vitest'

const leaderElectionMocks = vi.hoisted(() => ({
  requireLeaderForMutationHttp: vi.fn(() => null),
}))

const webhookMocks = vi.hoisted(() => ({
  postImplementationSourceWebhookHandler: vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
}))

vi.mock('../../../../../server/leader-election', () => leaderElectionMocks)
vi.mock('../../../../../server/implementation-source-webhooks', () => webhookMocks)

import { Route } from './$provider'

const postHandler = Route.options.server?.handlers?.POST

describe('implementation source webhook route', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('requires leadership before mutating implementation sources', async () => {
    expect(postHandler).toBeDefined()
    leaderElectionMocks.requireLeaderForMutationHttp.mockReturnValueOnce(
      new Response('not leader', { status: 503 }) as never,
    )

    const response = await postHandler!({
      params: { provider: 'github' },
      request: new Request('http://agents.test/api/agents/implementation-sources/webhooks/github', { method: 'POST' }),
    } as never)

    expect(response.status).toBe(503)
    expect(webhookMocks.postImplementationSourceWebhookHandler).not.toHaveBeenCalled()
  })

  it('delegates provider webhook ingestion to the Agents handler', async () => {
    expect(postHandler).toBeDefined()
    const request = new Request('http://agents.test/api/agents/implementation-sources/webhooks/github', {
      body: '{}',
      method: 'POST',
    })

    const response = await postHandler!({ params: { provider: 'github' }, request } as never)

    expect(response.status).toBe(200)
    expect(webhookMocks.postImplementationSourceWebhookHandler).toHaveBeenCalledWith('github', request)
  })
})
