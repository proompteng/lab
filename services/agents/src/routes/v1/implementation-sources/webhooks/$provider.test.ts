import { afterEach, describe, expect, it, vi } from 'vitest'

const leaderElectionMocks = vi.hoisted(() => ({
  requireLeaderForMutationHttp: vi.fn(() => null),
}))

const webhookMocks = vi.hoisted(() => ({
  postImplementationSourceWebhookHandler: vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
}))

vi.mock('../../../../server/leader-election', () => leaderElectionMocks)
vi.mock('../../../../server/implementation-source-webhooks', () => webhookMocks)

import { Route } from './$provider'

const postHandler = Route.options.server?.handlers?.POST

describe('implementation source webhook route', () => {
  afterEach(() => {
    delete process.env.AGENTS_IMPLEMENTATION_SOURCE_WEBHOOKS_GONE
    vi.clearAllMocks()
  })

  it('returns Gone and directs public webhook senders to Froussard', async () => {
    process.env.AGENTS_IMPLEMENTATION_SOURCE_WEBHOOKS_GONE = 'true'
    expect(postHandler).toBeDefined()
    const request = new Request('http://agents.test/v1/implementation-sources/webhooks/linear', {
      body: '{}',
      method: 'POST',
    })

    const response = await postHandler!({ params: { provider: 'linear' }, request } as never)

    expect(response.status).toBe(410)
    expect(response.headers.get('deprecation')).toBe('true')
    expect(response.headers.get('link')).toBe(
      '<https://froussard.proompteng.ai/webhooks/linear>; rel="successor-version"',
    )
    await expect(response.json()).resolves.toEqual({
      error: 'gone',
      message: 'Public webhook ingestion is owned by Froussard.',
      successor: 'https://froussard.proompteng.ai/webhooks/linear',
    })
    expect(leaderElectionMocks.requireLeaderForMutationHttp).not.toHaveBeenCalled()
    expect(webhookMocks.postImplementationSourceWebhookHandler).not.toHaveBeenCalled()
  })

  it('requires leadership while the Froussard cutover is dormant', async () => {
    expect(postHandler).toBeDefined()
    leaderElectionMocks.requireLeaderForMutationHttp.mockReturnValueOnce(
      new Response('not leader', { status: 503 }) as never,
    )

    const response = await postHandler!({
      params: { provider: 'linear' },
      request: new Request('http://agents.test/v1/implementation-sources/webhooks/linear', { method: 'POST' }),
    } as never)

    expect(response.status).toBe(503)
    expect(webhookMocks.postImplementationSourceWebhookHandler).not.toHaveBeenCalled()
  })

  it('keeps the legacy handler live until the Froussard cutover is enabled', async () => {
    expect(postHandler).toBeDefined()
    const request = new Request('http://agents.test/v1/implementation-sources/webhooks/linear', {
      body: '{}',
      method: 'POST',
    })

    const response = await postHandler!({ params: { provider: 'linear' }, request } as never)

    expect(response.status).toBe(200)
    expect(webhookMocks.postImplementationSourceWebhookHandler).toHaveBeenCalledWith('linear', request)
  })
})
