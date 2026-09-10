import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, vi } from 'vitest'

import { createProjectedIdentityFetch } from './bridge-auth'

describe('Linear MCP projected identity transport', () => {
  it('reads the rotating projected token before every request', async () => {
    let token = 'token-one'
    const seen: string[] = []
    const fetchMock = vi.fn<FetchLike>(async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json({ ok: true })
    })
    const authenticatedFetch = createProjectedIdentityFetch({
      tokenPath: '/projected/token',
      readFile: vi.fn(async () => token),
      fetch: fetchMock,
    })

    await authenticatedFetch('http://gateway.test/mcp')
    token = 'token-two'
    await authenticatedFetch('http://gateway.test/mcp')

    expect(seen).toEqual(['Bearer token-one', 'Bearer token-two'])
  })

  it('re-reads the projected token once after a 401', async () => {
    const readFile = vi.fn().mockResolvedValueOnce('expired-token').mockResolvedValueOnce('rotated-token')
    const fetchMock = vi.fn<FetchLike>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return new Response(null, { status: authorization === 'Bearer expired-token' ? 401 : 200 })
    })

    const response = await createProjectedIdentityFetch({
      tokenPath: '/projected/token',
      readFile,
      fetch: fetchMock,
    })('http://gateway.test/mcp')

    expect(response.status).toBe(200)
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
