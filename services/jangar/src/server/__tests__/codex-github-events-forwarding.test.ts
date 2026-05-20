import { describe, expect, it, vi } from 'vitest'

import { postGithubEventsHandler } from '~/routes/api/codex/github-events'

describe('codex GitHub event forwarding route', () => {
  it('forwards Codex projection events to Agents service', async () => {
    const client = vi.fn(async () => ({
      ok: true as const,
      status: 202,
      body: { ok: true, event: 'check_run', updatedRunIds: ['run-1'] },
    }))

    const response = await postGithubEventsHandler(
      new Request('http://localhost/api/codex/github-events', {
        body: JSON.stringify({ event: 'check_run', payload: { check_run: { head_sha: 'a'.repeat(40) } } }),
        method: 'POST',
      }),
      client,
    )

    expect(client).toHaveBeenCalledWith({
      event: 'check_run',
      payload: { check_run: { head_sha: 'a'.repeat(40) } },
    })
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ ok: true, event: 'check_run', updatedRunIds: ['run-1'] })
  })

  it('preserves Agents service failures', async () => {
    const client = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      body: null,
      error: 'Agents service unavailable',
    }))

    const response = await postGithubEventsHandler(
      new Request('http://localhost/api/codex/github-events', {
        body: JSON.stringify({ event: 'check_run', payload: {} }),
        method: 'POST',
      }),
      client,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'Agents service unavailable' })
  })
})
