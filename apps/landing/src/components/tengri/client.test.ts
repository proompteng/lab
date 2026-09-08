import { afterEach, describe, expect, test } from 'bun:test'

import {
  beginTengriLifecycleTransition,
  getTengriGuestOperationSnapshot,
  runTengriAction,
  subscribeTengriGuestOperations,
} from './client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
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

    expect(await runTengriAction<{ phase: string }>({ action: 'sleep-agent', agentId })).toEqual({ phase: 'sleeping' })
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
