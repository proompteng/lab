import { describe, expect, it } from 'vitest'

import { type ControllerRateState, reserveControllerRateLimit, resetControllerRateState } from './rate-limits'

const createRateState = (): ControllerRateState => ({
  cluster: { count: 0, resetAt: 0 },
  perNamespace: new Map(),
  perRepo: new Map(),
})

describe('agents controller rate-limits module', () => {
  it.each(['cluster', 'namespace', 'repo'] as const)('holds %s budget across concurrent starts', async (scope) => {
    const state = createRateState()
    const limits = {
      windowSeconds: 60,
      perNamespace: scope === 'namespace' ? 2 : 0,
      perRepo: scope === 'repo' ? 2 : 0,
      cluster: scope === 'cluster' ? 2 : 0,
    }
    const start = Promise.withResolvers<void>()
    const attempts = Array.from({ length: 20 }, async (_, i) => {
      await start.promise
      return reserveControllerRateLimit({
        namespace: scope === 'namespace' ? 'shared' : `agents-${i}`,
        repository: scope === 'repo' ? (i % 2 === 0 ? 'Org/Repo' : 'org/repo') : null,
        limits,
        now: 1_000,
        state,
      })
    })
    start.resolve()
    const reservations = await Promise.all(attempts)

    expect(reservations.filter((decision) => decision.ok)).toHaveLength(2)
    expect(reservations.filter((decision) => !decision.ok)).toEqual(
      Array(18).fill(expect.objectContaining({ ok: false, scope, retryAt: 61_000 })),
    )
  })

  it('releases all reserved scopes without refunding a newer window or releasing twice', () => {
    const state = createRateState()
    const limits = { windowSeconds: 60, perNamespace: 1, perRepo: 1, cluster: 1 }
    const reserve = (now: number) =>
      reserveControllerRateLimit({ namespace: 'agents', repository: 'org/repo', state, limits, now })
    const old = reserve(1_000)
    if (!old.ok) throw new Error('expected the old reservation to succeed')
    const current = reserve(61_000)
    if (!current.ok) throw new Error('expected the new window to allow the next start')

    old.release()
    expect(reserve(61_001)).toMatchObject({ ok: false, scope: 'cluster' })

    current.release()
    const next = reserve(61_002)
    expect(next.ok).toBe(true)
    current.release()
    expect(reserve(61_003)).toMatchObject({ ok: false, scope: 'cluster' })
  })

  it('does not allocate buckets when rate limiting is disabled', () => {
    const state = createRateState()
    const limits = { windowSeconds: 60, perNamespace: 0, perRepo: 0, cluster: 0 }
    expect(
      reserveControllerRateLimit({ namespace: 'agents', repository: 'Org/Repo', state, limits, now: 1_000 }),
    ).toMatchObject({ ok: true })
    expect(state).toEqual(createRateState())
  })

  it('resets controller rate state maps and counters', () => {
    const state = createRateState()
    state.cluster = { count: 9, resetAt: 999 }
    state.perNamespace.set('a', { count: 1, resetAt: 1 })
    state.perRepo.set('r', { count: 1, resetAt: 1 })

    resetControllerRateState(state)

    expect(state.cluster).toEqual({ count: 0, resetAt: 0 })
    expect(state.perNamespace.size).toBe(0)
    expect(state.perRepo.size).toBe(0)
  })

  it('evaluates cluster, namespace, and repository rate limits', () => {
    const limits = {
      windowSeconds: 60,
      perNamespace: 1,
      perRepo: 1,
      cluster: 2,
    }

    const state = createRateState()

    expect(
      reserveControllerRateLimit({
        namespace: 'agents',
        repository: 'Org/Repo',
        state,
        limits,
        now: 1000,
      }),
    ).toMatchObject({ ok: true })

    expect(
      reserveControllerRateLimit({
        namespace: 'agents',
        repository: 'Org/Repo',
        state,
        limits,
        now: 2000,
      }),
    ).toEqual({
      ok: false,
      scope: 'namespace',
      retryAt: 61_000,
      message: 'Namespace agents rate limit reached',
    })

    const repoState = createRateState()
    expect(
      reserveControllerRateLimit({
        namespace: 'agents-a',
        repository: 'Org/Repo',
        state: repoState,
        limits: { ...limits, perNamespace: 2 },
        now: 1000,
      }),
    ).toMatchObject({ ok: true })

    expect(
      reserveControllerRateLimit({
        namespace: 'agents-b',
        repository: 'Org/Repo',
        state: repoState,
        limits: { ...limits, perNamespace: 2 },
        now: 1500,
      }),
    ).toEqual({
      ok: false,
      scope: 'repo',
      retryAt: 61_000,
      message: 'Repository Org/Repo rate limit reached',
    })

    const clusterState = createRateState()
    expect(
      reserveControllerRateLimit({
        namespace: 'agents-a',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 100,
      }),
    ).toMatchObject({ ok: true })

    expect(
      reserveControllerRateLimit({
        namespace: 'agents-b',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 200,
      }),
    ).toMatchObject({ ok: true })

    expect(
      reserveControllerRateLimit({
        namespace: 'agents-c',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 300,
      }),
    ).toEqual({
      ok: false,
      scope: 'cluster',
      retryAt: 60_100,
      message: 'Cluster rate limit reached',
    })
  })

  it('does not consume cluster or namespace budget when a repository is throttled', () => {
    const state = createRateState()
    const limits = { windowSeconds: 60, perNamespace: 2, perRepo: 1, cluster: 3 }
    const admit = (namespace: string, repository: string, now: number) =>
      reserveControllerRateLimit({ namespace, repository, state, limits, now })

    expect(admit('agents', 'org/hot', 1_000)).toMatchObject({ ok: true })
    for (let i = 0; i < 200; i += 1) {
      expect(admit('agents', 'Org/Hot', 2_000)).toMatchObject({ ok: false, scope: 'repo' })
    }
    expect(admit('agents', 'org/cold', 2_000)).toMatchObject({ ok: true })
    expect(admit('agents', 'org/third', 2_000)).toMatchObject({ ok: false, scope: 'namespace' })
    expect(admit('other', 'org/third', 2_000)).toMatchObject({ ok: true })
    expect(admit('other', 'org/fourth', 2_000)).toMatchObject({ ok: false, scope: 'cluster', retryAt: 61_000 })
    expect(admit('agents', 'Org/Hot', 61_000)).toMatchObject({ ok: true })
  })
})
