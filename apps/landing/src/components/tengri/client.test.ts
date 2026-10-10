import { afterAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'

import {
  beginTengriLifecycleTransition,
  getTengriGuestOperationSnapshot,
  runTengriAction,
  subscribeTengriGuestOperations,
  TengriRequestError,
} from './client'

const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const values = new Map<string, string>()
const storage: Storage = {
  get length() {
    return values.size
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => {
    values.set(key, value)
  },
  removeItem: (key) => {
    values.delete(key)
  },
  key: (index) => [...values.keys()][index] ?? null,
}
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
beforeEach(() => storage.clear())
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'sessionStorage')
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('preserves HTTP status and recognized conversation errors without trusting other payload shapes', async () => {
  for (const [status, body, message, code] of [
    [
      404,
      { error: 'Codex conversation could not be found', code: 'conversation_not_found' },
      'Codex conversation could not be found',
      'conversation_not_found',
    ],
    [
      503,
      { error: 'Tengri control plane is unavailable', code: 'conversation_not_found' },
      'Tengri control plane is unavailable',
      undefined,
    ],
    [404, { error: { internal: 'details' }, code: 'unknown' }, 'Tengri request failed with 404', undefined],
    [409, { error: 'File changed', code: 'file_conflict' }, 'File changed', 'file_conflict'],
    [429, { error: 'All slots occupied', code: 'capacity_full' }, 'All slots occupied', 'capacity_full'],
    [
      412,
      { error: 'Model selection unavailable', code: 'model_selection_unavailable' },
      'Model selection unavailable',
      'model_selection_unavailable',
    ],
    [503, { error: 'Unavailable', code: 'model_selection_unavailable' }, 'Unavailable', undefined],
    [503, { error: 'Unavailable', code: 'file_conflict' }, 'Unavailable', undefined],
  ] as const) {
    globalThis.fetch = Object.assign(async () => Response.json(body, { status }), {
      preconnect: originalFetch.preconnect,
    })
    const error = await runTengriAction({
      action: 'resume-thread',
      agentId: 'agent-errors',
      threadId: 'thread-missing',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TengriRequestError)
    expect(error).toMatchObject({ status, message, code })
  }
})

describe('Tengri guest operation coordination', () => {
  test('blocks new guest requests and cancels in-flight work before a lifecycle transition', async () => {
    const agentId = 'agent-lifecycle'
    const snapshots: boolean[] = []
    const actions: string[] = []
    globalThis.fetch = (async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const action = JSON.parse(init.body) as { action: string }
      actions.push(action.action)
      if (action.action === 'list-files') {
        await waitForAbort(init?.signal)
        throw init?.signal?.reason
      }
      return Response.json({ result: action.action === 'sleep-agent' ? { phase: 'sleeping' } : { entries: [] } })
    }) as typeof fetch

    const unsubscribe = subscribeTengriGuestOperations(agentId, () => {
      snapshots.push(getTengriGuestOperationSnapshot(agentId))
    })
    const pending = runTengriAction({ action: 'list-files', agentId, path: '/' }).catch((error: unknown) => error)
    expect(getTengriGuestOperationSnapshot(agentId)).toBe(true)

    const releaseTransition = beginTengriLifecycleTransition(agentId)
    const cancellation = await pending
    expect(cancellation).toBeInstanceOf(DOMException)
    expect((cancellation as DOMException).name).toBe('AbortError')
    expect(getTengriGuestOperationSnapshot(agentId)).toBe(false)

    const callsBeforeBlockedRequest = actions.length
    const blocked = await runTengriAction({ action: 'list-files', agentId, path: '/' }).catch((error: unknown) => error)
    expect(blocked).toBeInstanceOf(Error)
    expect((blocked as Error).message).toBe('Agent lifecycle transition is in progress')
    expect(actions).toHaveLength(callsBeforeBlockedRequest)

    expect(
      await runTengriAction<{ phase: string }>(
        {
          action: 'sleep-agent',
          agentId,
          workspaceUid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
        { principalId: 'fixture-human' },
      ),
    ).toEqual({ phase: 'sleeping' })
    expect(actions.at(-1)).toBe('sleep-agent')

    releaseTransition()
    expect(
      await runTengriAction<{ entries: never[] }>({ action: 'search-files', agentId, path: '/', query: 'readme' }),
    ).toEqual({ entries: [] })
    expect(snapshots).toEqual([true, false, true, false])
    unsubscribe()
  })

  test('preserves caller cancellation while tracking the shared guest request', async () => {
    const agentId = 'agent-caller-abort'
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await waitForAbort(init?.signal)
      throw init?.signal?.reason
    }) as unknown as typeof fetch
    const caller = new AbortController()
    const pending = runTengriAction({ action: 'codex-account', agentId }, caller.signal).catch(
      (error: unknown) => error,
    )

    expect(getTengriGuestOperationSnapshot(agentId)).toBe(true)
    caller.abort(new DOMException('Caller stopped waiting', 'AbortError'))
    const cancellation = await pending

    expect(cancellation).toBeInstanceOf(DOMException)
    expect((cancellation as DOMException).message).toBe('Caller stopped waiting')
    expect(getTengriGuestOperationSnapshot(agentId)).toBe(false)
  })
})

function waitForAbort(signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

test('reuses the persisted lifecycle operation after an uncertain response and allocates a new ID only after success', async () => {
  const requests: Array<{ action: string; operationId: string }> = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return requests.length === 1
      ? Response.json({ error: 'Unavailable' }, { status: 503 })
      : Response.json({ result: { id: 'agent-test' } })
  }) as typeof fetch
  const action = { action: 'create-agent' as const, displayName: 'Retained workspace' }
  const options = { principalId: 'fixture-human' }
  await expect(runTengriAction(action, options)).rejects.toMatchObject({ status: 503 })
  expect(storage.getItem('tengri.pending-lifecycle.v2/fixture-human')).toContain(requests[0].operationId)
  await runTengriAction(action, options)
  expect(requests[1].operationId).toBe(requests[0].operationId)
  expect(storage.getItem('tengri.pending-lifecycle.v2/fixture-human')).toBe('[]')
  await runTengriAction(action, options)
  expect(requests[2].operationId).not.toBe(requests[0].operationId)
})

test('retains the exact creation request until its uncertain outcome is resolved', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new TypeError('connection lost')
  }) as unknown as typeof fetch
  const options = { principalId: 'fixture-human' }
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Original' }, options)).rejects.toThrow(
    'connection lost',
  )
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Changed' }, options)).rejects.toThrow(
    'still pending',
  )
  expect(calls).toBe(1)
})

test.each(['Original', 'Different'])(
  'scopes uncertain creates to each signed-in principal: %s',
  async (displayName) => {
    const requests: Array<{ operationId: string }> = []
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return requests.length === 1
        ? Response.json({ error: 'Unavailable' }, { status: 503 })
        : Response.json({ result: { id: 'agent-test' } })
    }) as typeof fetch
    const original = { action: 'create-agent' as const, displayName: 'Original' }
    await expect(runTengriAction(original, { principalId: 'first-human' })).rejects.toMatchObject({ status: 503 })
    await runTengriAction({ action: 'create-agent', displayName }, { principalId: 'second-human' })
    expect(requests[1].operationId).not.toBe(requests[0].operationId)
    await runTengriAction(original, { principalId: 'first-human' })
    expect(requests[2].operationId).toBe(requests[0].operationId)
  },
)

test('clears a superseded lifecycle operation before a fresh retry without acknowledging it', async () => {
  const requests: Array<{ operationId: string }> = []
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return requests.length === 1
      ? Response.json({ error: 'Superseded', code: 'lifecycle_superseded' }, { status: 409 })
      : Response.json({ result: {} })
  }) as typeof fetch
  const action = { action: 'sleep-agent' as const, agentId: 'agent-test', workspaceUid: crypto.randomUUID() }
  const options = { principalId: 'first-human' }
  await expect(runTengriAction(action, options)).rejects.toMatchObject({ status: 409, code: 'lifecycle_superseded' })
  await runTengriAction(action, options)
  expect(requests[1].operationId).not.toBe(requests[0].operationId)
})

test('requires a signed-in principal before allocating or sending a lifecycle operation', async () => {
  let called = false
  globalThis.fetch = Object.assign(
    async () => {
      called = true
      return Response.json({ result: {} })
    },
    { preconnect: originalFetch.preconnect },
  )
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Original' })).rejects.toThrow(
    'signed-in session',
  )
  expect(called).toBe(false)
  expect(storage.length).toBe(0)
})
