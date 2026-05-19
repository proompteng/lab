import { afterEach, describe, expect, it, vi } from 'vitest'

const webhookMocks = vi.hoisted(() => ({
  proxyImplementationSourceWebhook: vi.fn(async () => new Response('proxied', { status: 202 })),
}))

vi.mock('~/server/implementation-source-webhooks', () => webhookMocks)

import { Route } from './$provider'

describe('control-plane implementation source webhook route', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('proxies provider webhook POST requests to the Agents service', async () => {
    const request = new Request('http://jangar.test/api/control-plane/implementation-sources/webhooks/github', {
      body: '{}',
      method: 'POST',
    })
    const response = await Route.options.server.handlers.POST({ params: { provider: 'github' }, request } as never)

    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe('proxied')
    expect(webhookMocks.proxyImplementationSourceWebhook).toHaveBeenCalledWith(request, 'github')
  })
})
