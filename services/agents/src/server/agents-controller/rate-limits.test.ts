import { describe, expect, it } from 'vitest'

import { type ControllerRateState, checkControllerRateLimits, resetControllerRateState } from './rate-limits'

const createRateState = (): ControllerRateState => ({
  cluster: { count: 0, resetAt: 0 },
  perNamespace: new Map(),
  perRepo: new Map(),
})

describe('agents controller rate-limits module', () => {
  it('does not allocate buckets when rate limiting is disabled', () => {
    const state = createRateState()
    const limits = { windowSeconds: 60, perNamespace: 0, perRepo: 0, cluster: 0 }
    expect(
      checkControllerRateLimits({ namespace: 'agents', repository: 'Org/Repo', state, limits, now: 1_000 }),
    ).toEqual({ ok: true })
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
      checkControllerRateLimits({
        namespace: 'agents',
        repository: 'Org/Repo',
        state,
        limits,
        now: 1000,
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents',
        repository: 'Org/Repo',
        state,
        limits,
        now: 2000,
      }),
    ).toEqual({
      ok: false,
      scope: 'namespace',
      retryAfterSeconds: 59,
      message: 'Namespace agents rate limit reached',
    })

    const repoState = createRateState()
    expect(
      checkControllerRateLimits({
        namespace: 'agents-a',
        repository: 'Org/Repo',
        state: repoState,
        limits: { ...limits, perNamespace: 2 },
        now: 1000,
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-b',
        repository: 'Org/Repo',
        state: repoState,
        limits: { ...limits, perNamespace: 2 },
        now: 1500,
      }),
    ).toEqual({
      ok: false,
      scope: 'repo',
      retryAfterSeconds: 60,
      message: 'Repository Org/Repo rate limit reached',
    })

    const clusterState = createRateState()
    expect(
      checkControllerRateLimits({
        namespace: 'agents-a',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 100,
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-b',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 200,
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-c',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 300,
      }),
    ).toEqual({
      ok: false,
      scope: 'cluster',
      retryAfterSeconds: 60,
      message: 'Cluster rate limit reached',
    })
  })

  it('does not consume cluster or namespace budget when a repository is throttled', () => {
    const state = createRateState()
    const limits = { windowSeconds: 60, perNamespace: 2, perRepo: 1, cluster: 3 }
    const admit = (namespace: string, repository: string, now: number) =>
      checkControllerRateLimits({ namespace, repository, state, limits, now })

    expect(admit('agents', 'org/hot', 1_000)).toEqual({ ok: true })
    for (let i = 0; i < 200; i += 1) {
      expect(admit('agents', 'Org/Hot', 2_000)).toMatchObject({ ok: false, scope: 'repo' })
    }
    expect(admit('agents', 'org/cold', 2_000)).toEqual({ ok: true })
    expect(admit('agents', 'org/third', 2_000)).toMatchObject({ ok: false, scope: 'namespace' })
    expect(admit('other', 'org/third', 2_000)).toEqual({ ok: true })
    expect(admit('other', 'org/fourth', 2_000)).toMatchObject({ ok: false, scope: 'cluster', retryAfterSeconds: 59 })
    expect(admit('agents', 'Org/Hot', 61_000)).toEqual({ ok: true })
  })
})
