import { afterAll, beforeEach, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/browser'
import type { TengriAction } from '@/lib/tengri/types'

import {
  beginTengriLifecycleTransition,
  getTengriGuestOperationSnapshot,
  getDesktopSnapshot,
  runTengriAction,
  subscribeTengriGuestOperations,
  TengriRequestError,
} from './client'

import { MemoryStorage } from '@/lib/tengri/storage.fixture'

const originalFetch = globalThis.fetch

function stubFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response> | Response) {
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => handler(...args), {
    preconnect: originalFetch.preconnect,
  })
}
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const lockQueues = new Map<string, Promise<void>>()
const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    async request(name: string, callback: () => unknown) {
      const previous = lockQueues.get(name) ?? Promise.resolve()
      const { promise: queued, resolve: release } = Promise.withResolvers<void>()
      lockQueues.set(name, queued)
      await previous
      try {
        return await callback()
      } finally {
        release()
        if (lockQueues.get(name) === queued) lockQueues.delete(name)
      }
    },
  },
})
beforeEach(() => storage.clear())
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('reports rejected snapshot and action fetches without reporting caller cancellation', async () => {
  const capture = spyOn(Sentry, 'captureException').mockReturnValue('fixture-event')
  const failure = new TypeError('PRIVATE_SENTINEL transport failed')
  stubFetch(async () => {
    throw failure
  })
  try {
    await expect(getDesktopSnapshot()).rejects.toBe(failure)
    await expect(
      runTengriAction({ action: 'list-files', agentId: 'network-fixture', path: '/workspace' }),
    ).rejects.toBe(failure)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(String(capture.mock.calls)).not.toContain('PRIVATE_SENTINEL')
    const controller = new AbortController()
    controller.abort()
    await expect(getDesktopSnapshot(controller.signal)).rejects.toBe(failure)
    expect(capture).toHaveBeenCalledTimes(2)
  } finally {
    capture.mockRestore()
  }
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
    [502, { error: 'Invalid catalog', code: 'model_catalog_invalid' }, 'Invalid catalog', 'model_catalog_invalid'],
    [503, { error: 'Unavailable', code: 'model_catalog_invalid' }, 'Unavailable', undefined],
    [
      412,
      { error: 'Runtime upgrade required', code: 'runtime_upgrade_required' },
      'Runtime upgrade required',
      'runtime_upgrade_required',
    ],
    [503, { error: 'Unavailable', code: 'runtime_upgrade_required' }, 'Unavailable', undefined],
    [
      412,
      { error: 'Model selection unavailable', code: 'model_selection_unavailable' },
      'Model selection unavailable',
      undefined,
    ],
    [503, { error: 'Unavailable', code: 'model_selection_unavailable' }, 'Unavailable', undefined],
    [503, { error: 'Unavailable', code: 'file_conflict' }, 'Unavailable', undefined],
  ] as const) {
    stubFetch(async () => Response.json(body, { status }))
    const error = await runTengriAction({
      action: 'resume-thread',
      agentId: 'agent-errors',
      threadId: 'thread-missing',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(TengriRequestError)
    expect(error).toMatchObject({ status, message, code })
  }
})

test('reports a failed history record from an HTTP 200 stream with its response trace', async () => {
  let tags: Record<string, unknown> = {}
  const capture = spyOn(Sentry, 'captureException').mockImplementation(() => {
    tags = Sentry.getCurrentScope().getScopeData().tags
    return 'fixture-event'
  })
  const traceId = 'd'.repeat(32)
  stubFetch(
    async () =>
      new Response(
        [
          {
            type: 'page',
            part: 'thread',
            eventSequence: 1,
            rawJson: JSON.stringify({ thread: { id: 'history-fixture', historyMode: 'paginated', turns: [] } }),
          },
          { type: 'error', status: 504, error: 'History source unavailable' },
        ]
          .map((record) => JSON.stringify(record) + '\n')
          .join(''),
        {
          headers: { 'Content-Type': 'application/x-ndjson', 'x-trace-id': traceId },
        },
      ),
  )
  try {
    await expect(
      runTengriAction({ action: 'resume-thread', agentId: 'history-errors', threadId: 'history-fixture' }),
    ).rejects.toMatchObject({ status: 504 })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(tags).toMatchObject({ trace_id: traceId, status: 504 })
  } finally {
    capture.mockRestore()
  }
})

describe('Tengri guest operation coordination', () => {
  for (const action of [
    { action: 'codex-models', agentId: 'catalog-lifecycle' },
    { action: 'resume-thread', agentId: 'history-lifecycle', threadId: 'thread-existing' },
  ] satisfies TengriAction[]) {
    test(`keeps lifecycle controls available during ${action.action} and cancels it on transition`, async () => {
      const agentId = action.agentId
      const started = Promise.withResolvers<void>()
      stubFetch(async (_input, init) => {
        started.resolve()
        await waitForAbort(init?.signal)
        throw init?.signal?.reason
      })
      const pending = runTengriAction(action).catch((error: unknown) => error)
      await started.promise
      const blocked = getTengriGuestOperationSnapshot(agentId)
      const releaseTransition = beginTengriLifecycleTransition(agentId)
      try {
        expect(await pending).toMatchObject({ name: 'AbortError' })
        expect(blocked).toBe(false)
        expect(getTengriGuestOperationSnapshot(agentId)).toBe(false)
      } finally {
        releaseTransition()
      }
    })
  }

  test('blocks new guest requests and cancels in-flight work before a lifecycle transition', async () => {
    const agentId = 'agent-lifecycle'
    const snapshots: boolean[] = []
    const actions: string[] = []
    stubFetch(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const action = JSON.parse(init.body) as { action: string }
      actions.push(action.action)
      if (action.action === 'list-files') {
        await waitForAbort(init?.signal)
        throw init?.signal?.reason
      }
      return Response.json({ result: action.action === 'sleep-agent' ? { phase: 'sleeping' } : { entries: [] } })
    })

    const unsubscribe = subscribeTengriGuestOperations(agentId, () => {
      snapshots.push(getTengriGuestOperationSnapshot(agentId))
    })
    const pending = runTengriAction({ action: 'list-files', agentId, path: '/workspace' }).catch(
      (error: unknown) => error,
    )
    expect(getTengriGuestOperationSnapshot(agentId)).toBe(true)

    const releaseTransition = beginTengriLifecycleTransition(agentId)
    const cancellation = await pending
    expect(cancellation).toBeInstanceOf(DOMException)
    expect((cancellation as DOMException).name).toBe('AbortError')
    expect(getTengriGuestOperationSnapshot(agentId)).toBe(false)

    const callsBeforeBlockedRequest = actions.length
    const blocked = await runTengriAction({ action: 'list-files', agentId, path: '/workspace' }).catch(
      (error: unknown) => error,
    )
    expect(blocked).toBeInstanceOf(Error)
    expect((blocked as Error).message).toBe('Agent lifecycle transition is in progress')
    expect(blocked).toMatchObject({ name: 'AbortError' })
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
      await runTengriAction<{ entries: never[] }>({
        action: 'search-files',
        agentId,
        path: '/workspace',
        query: 'readme',
      }),
    ).toEqual({ entries: [] })
    expect(snapshots).toEqual([true, false, true, false])
    unsubscribe()
  })

  test('preserves caller cancellation while tracking the shared guest request', async () => {
    const agentId = 'agent-caller-abort'
    stubFetch(async (_input, init) => {
      await waitForAbort(init?.signal)
      throw init?.signal?.reason
    })
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

const fixtureOptions = { principalId: 'fixture-human' }
type RecordedAction = { action: string; operationId: string; displayName?: string }

function captureLifecycleRequests(respond: (request: RecordedAction, requests: RecordedAction[]) => Response) {
  const requests: RecordedAction[] = []
  stubFetch(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    const request = JSON.parse(init.body) as RecordedAction
    requests.push(request)
    return respond(request, requests)
  })
  return requests
}

const lifecycleResult = (result: unknown = {}) => Response.json({ result })
const workspaceRemoved = () =>
  Response.json({ error: 'Workspace removed', code: 'lifecycle_superseded' }, { status: 409 })

test('reuses an uncertain runtime operation and allocates a new ID only after success', async () => {
  const requests = captureLifecycleRequests((_request, recorded) => {
    return recorded.length === 1
      ? Response.json({ error: 'Unavailable' }, { status: 503 })
      : Response.json({ result: { id: 'agent-test' } })
  })
  const action = { action: 'sleep-agent' as const, agentId: 'agent-test', workspaceUid: crypto.randomUUID() }
  await expect(runTengriAction(action, fixtureOptions)).rejects.toMatchObject({ status: 503 })
  expect(storage.getItem('tengri.pending-lifecycle.v2/fixture-human')).toContain(requests[0].operationId)
  await runTengriAction(action, fixtureOptions)
  expect(requests[1].operationId).toBe(requests[0].operationId)
  expect(storage.getItem('tengri.pending-lifecycle.v2/fixture-human')).toBe('[]')
  await runTengriAction(action, fixtureOptions)
  expect(requests[2].operationId).not.toBe(requests[0].operationId)
})

test('retains the exact creation request until its uncertain outcome is resolved', async () => {
  const requests = captureLifecycleRequests(() => {
    throw new TypeError('connection lost')
  })
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Original' }, fixtureOptions)).rejects.toThrow(
    'connection lost',
  )
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Changed' }, fixtureOptions)).rejects.toThrow(
    'connection lost',
  )
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
})

test('reconciles an externally removed creation before submitting a different name', async () => {
  const requests = captureLifecycleRequests((_request, recorded) => {
    return recorded.length === 2
      ? workspaceRemoved()
      : Response.json({ result: { displayName: recorded.at(-1)?.displayName } })
  })
  await runTengriAction({ action: 'create-agent', displayName: 'Original workspace' }, fixtureOptions)
  expect(
    await runTengriAction<{ displayName: string }>(
      { action: 'create-agent', displayName: 'Replacement workspace' },
      fixtureOptions,
    ),
  ).toEqual({
    displayName: 'Replacement workspace',
  })
  expect(requests.map((request) => request.displayName)).toEqual([
    'Original workspace',
    'Original workspace',
    'Replacement workspace',
  ])
  expect(requests[1].operationId).toBe(requests[0].operationId)
  expect(requests[2].operationId).not.toBe(requests[0].operationId)
})

test.each([403, 503])('preserves the original creation when reconciliation returns %s', async (status) => {
  const requests: Array<{ displayName: string; operationId: string }> = []
  let unavailable = true
  stubFetch(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
    requests.push(JSON.parse(init.body))
    if (requests.length > 1 && requests.at(-1)?.operationId === requests[0].operationId) {
      return unavailable ? Response.json({ error: 'Recovery denied or unavailable' }, { status }) : workspaceRemoved()
    }
    return lifecycleResult()
  })
  await runTengriAction({ action: 'create-agent', displayName: 'Original workspace' }, fixtureOptions)
  const replacement = { action: 'create-agent' as const, displayName: 'Replacement workspace' }
  expect(await runTengriAction(replacement, fixtureOptions).catch((error: unknown) => error)).toMatchObject({ status })
  expect(requests[1]).toEqual(requests[0])
  expect(storage.getItem('tengri.pending-lifecycle.v2/fixture-human')).toContain(requests[0].operationId)
  unavailable = false
  await runTengriAction(replacement, fixtureOptions)
  expect(requests[2]).toEqual(requests[0])
  expect(requests[3].displayName).toBe('Replacement workspace')
  expect(requests[3].operationId).not.toBe(requests[0].operationId)
})

test('retains a committed creation for stale tabs until its exact workspace is deleted', async () => {
  const requests = captureLifecycleRequests(() => lifecycleResult())
  const options = { principalId: '424242' }
  const original = { action: 'create-agent' as const, displayName: 'Shared workspace' }
  await runTengriAction(original, options)
  await runTengriAction(original, options)
  const creationId = requests[0].operationId
  expect(requests[1].operationId).toBe(creationId)
  expect(storage.getItem('tengri.pending-lifecycle.v2/424242')).toContain(creationId)
  await runTengriAction({ ...original, displayName: 'Another workspace' }, options)
  expect(requests).toHaveLength(3)
  expect(requests[2].operationId).toBe(creationId)
  const owner = createHash('sha256').update('github:424242').digest('hex')
  const agentId = `agent-${createHash('sha256').update(`ofz.workspace.v1\n${owner}\n${creationId}`).digest('hex').slice(0, 32)}`
  await runTengriAction({ action: 'delete-agent', agentId, workspaceUid: crypto.randomUUID() }, options)
  expect(storage.getItem('tengri.pending-lifecycle.v2/424242')).toBe('[]')
  await runTengriAction({ ...original, displayName: 'Replacement workspace' }, options)
  expect(requests[4].operationId).not.toBe(creationId)
})

test.each(['same', 'different'])(
  'serializes concurrent %s creation intents before either request is sent',
  async (name) => {
    const requests = captureLifecycleRequests(() => lifecycleResult())
    const outcomes = await Promise.allSettled([
      runTengriAction({ action: 'create-agent', displayName: 'Shared workspace' }, fixtureOptions),
      runTengriAction(
        { action: 'create-agent', displayName: name === 'same' ? 'Shared workspace' : 'Different' },
        fixtureOptions,
      ),
    ])
    expect(outcomes[0].status).toBe('fulfilled')
    expect(outcomes[1].status).toBe('fulfilled')
    expect(requests).toHaveLength(2)
    expect(requests[1].operationId).toBe(requests[0].operationId)
    expect(requests[1].displayName).toBe('Shared workspace')
  },
)

test('fails before sending a lifecycle request when cross-tab locking is unavailable', async () => {
  const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let called = false
  stubFetch(async () => {
    called = true
    return lifecycleResult()
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  try {
    await expect(
      runTengriAction({ action: 'create-agent', displayName: 'Shared workspace' }, { principalId: 'fixture-human' }),
    ).rejects.toThrow('supports Web Locks')
    expect(called).toBe(false)
    expect(storage.length).toBe(0)
  } finally {
    if (locks) Object.defineProperty(navigator, 'locks', locks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

test.each(['Original', 'Different'])(
  'scopes uncertain creates to each signed-in principal: %s',
  async (displayName) => {
    const requests = captureLifecycleRequests((_request, recorded) => {
      return recorded.length === 1
        ? Response.json({ error: 'Unavailable' }, { status: 503 })
        : Response.json({ result: { id: 'agent-test' } })
    })
    const original = { action: 'create-agent' as const, displayName: 'Original' }
    await expect(runTengriAction(original, { principalId: 'first-human' })).rejects.toMatchObject({ status: 503 })
    await runTengriAction({ action: 'create-agent', displayName }, { principalId: 'second-human' })
    expect(requests[1].operationId).not.toBe(requests[0].operationId)
    await runTengriAction(original, { principalId: 'first-human' })
    expect(requests[2].operationId).toBe(requests[0].operationId)
  },
)

test.each(['sleep-agent', 'create-agent'] as const)(
  'clears a superseded %s before a fresh retry without acknowledging it',
  async (kind) => {
    const requests = captureLifecycleRequests((_request, recorded) => {
      return recorded.length === 1
        ? Response.json({ error: 'Superseded', code: 'lifecycle_superseded' }, { status: 409 })
        : lifecycleResult()
    })
    const action =
      kind === 'create-agent'
        ? { action: kind, displayName: 'Tengri' }
        : { action: kind, agentId: 'agent-test', workspaceUid: crypto.randomUUID() }
    const options = { principalId: 'first-human' }
    await expect(runTengriAction(action, options)).rejects.toMatchObject({ status: 409, code: 'lifecycle_superseded' })
    await runTengriAction(
      action.action === 'create-agent' ? { ...action, displayName: 'New workspace' } : action,
      options,
    )
    expect(requests[1].operationId).not.toBe(requests[0].operationId)
  },
)

test.each(['matching', 'known-operation', 'unrelated', 'failed', 'another-principal'])(
  'retires an uncertain creation only after its confirmed workspace deletion: %s',
  async (deletion) => {
    const principalId = '424242'
    const original = { action: 'create-agent' as const, displayName: 'Original workspace' }
    if (deletion === 'known-operation') {
      storage.setItem(
        `tengri.pending-lifecycle.v2/${principalId}`,
        JSON.stringify([
          {
            key: 'create-agent',
            payload: JSON.stringify(original),
            operationId: '33333333-3333-4333-8333-333333333333',
          },
        ]),
      )
    }
    const requests: Array<{ action: string; operationId: string }> = []
    stubFetch(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as (typeof requests)[number]
      requests.push(request)
      if (requests.length === 1 || (deletion === 'failed' && request.action === 'delete-agent'))
        return Response.json({ error: 'Uncertain outcome' }, { status: 503 })
      return lifecycleResult()
    })
    await expect(runTengriAction(original, { principalId })).rejects.toMatchObject({ status: 503 })
    const creationId = requests[0].operationId
    const agentId =
      deletion === 'known-operation'
        ? 'agent-5e468ac5d213e74d5fef86ad1275def8'
        : `agent-${createHash('sha256')
            .update(
              `ofz.workspace.v1\n${createHash('sha256').update(`github:${principalId}`).digest('hex')}\n${creationId}`,
            )
            .digest('hex')
            .slice(0, 32)}`
    const pendingDelete = runTengriAction(
      {
        action: 'delete-agent',
        agentId: deletion === 'unrelated' ? 'agent-another-workspace' : agentId,
        workspaceUid: crypto.randomUUID(),
      },
      { principalId: deletion === 'another-principal' ? '424243' : principalId },
    )
    if (deletion === 'failed') await expect(pendingDelete).rejects.toMatchObject({ status: 503 })
    else await pendingDelete
    const changed = { ...original, displayName: 'Different workspace' }
    if (deletion === 'matching' || deletion === 'known-operation') {
      await runTengriAction(changed, { principalId })
      expect(requests[2].operationId).not.toBe(creationId)
    } else {
      await runTengriAction(changed, { principalId })
      await runTengriAction(original, { principalId })
      expect(requests[2].operationId).toBe(creationId)
      expect(requests[3].operationId).toBe(creationId)
    }
  },
)

test('requires a signed-in principal before allocating or sending a lifecycle operation', async () => {
  let called = false
  stubFetch(async () => {
    called = true
    return lifecycleResult()
  })
  await expect(runTengriAction({ action: 'create-agent', displayName: 'Original' })).rejects.toThrow(
    'signed-in session',
  )
  expect(called).toBe(false)
  expect(storage.length).toBe(0)
})

test('renews saved connections before a turn without making connector availability a chat precondition', async () => {
  const paths: string[] = []
  const action: TengriAction = {
    action: 'send-turn',
    agentId: 'microvm-fixture',
    threadId: 'thread-fixture',
    operationId: '11111111-1111-4111-8111-111111111111',
    text: 'Describe this function',
    images: [],
  }
  stubFetch(async (input: string | URL | Request, options?: RequestInit) => {
    const path = String(input)
    paths.push(path)
    if (path === '/api/tengri/connections') {
      expect(JSON.parse(String(options?.body))).toEqual({ kind: 'reconcile', agentId: action.agentId })
      return Response.json({ error: 'The connector is unavailable' }, { status: 503 })
    }
    expect(JSON.parse(String(options?.body))).toEqual(action)
    return Response.json({ result: { accepted: true } })
  })
  expect(await runTengriAction<{ accepted: boolean }>(action)).toEqual({ accepted: true })
  expect(paths).toEqual(['/api/tengri/connections', '/api/tengri'])
})
