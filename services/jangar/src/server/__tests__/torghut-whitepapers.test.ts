import { afterEach, describe, expect, it, vi } from 'vitest'

import { approveTorghutWhitepaperForImplementation } from '../torghut-whitepapers'

describe('approveTorghutWhitepaperForImplementation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.JANGAR_WHITEPAPER_CONTROL_BASE_URL
    delete process.env.JANGAR_WHITEPAPER_CONTROL_TOKEN
  })

  it('submits manual approval to Torghut with fixed jangar_ui source', async () => {
    process.env.JANGAR_WHITEPAPER_CONTROL_BASE_URL = 'http://torghut.internal/'
    process.env.JANGAR_WHITEPAPER_CONTROL_TOKEN = 'secret-token'

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run_id: 'wp-1', status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await approveTorghutWhitepaperForImplementation({
      runId: ' wp-1 ',
      approvedBy: 'ops@example.com',
      approvalReason: 'Manual override after operator review',
      targetScope: 'B1 candidate only',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/whitepaper-test',
      rolloutProfile: 'automatic',
    })

    expect(result).toEqual({ run_id: 'wp-1', status: 'completed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://torghut.internal/whitepapers/runs/wp-1/approve-implementation')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      approved_by: 'ops@example.com',
      approval_reason: 'Manual override after operator review',
      approval_source: 'jangar_ui',
      target_scope: 'B1 candidate only',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/whitepaper-test',
      rollout_profile: 'automatic',
    })
  })
})
