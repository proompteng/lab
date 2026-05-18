import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchJson, requestDatabaseAccess, submitTask } from './sag-client'

const jsonResponse = (body: unknown, init: Pick<Response, 'ok' | 'status'> = { ok: true, status: 200 }) =>
  ({
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response

describe('SAG API client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('encodes AgentRun names when requesting database access approval', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, tables: [], snapshot: {} }))

    await requestDatabaseAccess('agents/run with spaces')

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-runs/agents%2Frun%20with%20spaces/database-access', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'content-type': 'application/json',
      },
    })
  })

  test('sends natural-language tasks as JSON requests', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, task: { id: 'task-1' }, snapshot: {} }))

    await submitTask('Inspect live protected workloads')

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ text: 'Inspect live protected workloads' }),
      headers: {
        'content-type': 'application/json',
      },
    })
  })

  test('throws response errors from failed JSON responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: 'Request rejected by policy' }, { ok: false, status: 403 }),
    )

    await expect(fetchJson('/api/tasks')).rejects.toThrow('Request rejected by policy')
  })
})
