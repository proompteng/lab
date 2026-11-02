import { describe, expect, it } from 'vitest'

import {
  type ControllerRateState,
  checkControllerRateLimits,
  checkRateLimit,
  getRateBucket,
  resetControllerRateState,
} from '~/server/agents-controller/rate-limits'

const createRateState = (): ControllerRateState => ({
  cluster: { count: 0, resetAt: 0 },
  perNamespace: new Map(),
  perRepo: new Map(),
})

describe('agents controller rate-limits module', () => {
  it('creates and reuses buckets', () => {
    const map = new Map<string, { count: number; resetAt: number }>()
    const first = getRateBucket(map, 'ns-a')
    const second = getRateBucket(map, 'ns-a')

    expect(first).toBe(second)
    expect(map.get('ns-a')).toBe(first)
  })

  it('applies bucket windowing and retry-after behavior', () => {
    const bucket = { count: 0, resetAt: 0 }

    expect(checkRateLimit(bucket, 2, 1000, 100)).toEqual({ ok: true })
    expect(bucket).toEqual({ count: 1, resetAt: 1100 })

    expect(checkRateLimit(bucket, 2, 1000, 200)).toEqual({ ok: true })
    expect(bucket.count).toBe(2)

    expect(checkRateLimit(bucket, 2, 1000, 300)).toEqual({ ok: false, retryAfterSeconds: 1 })

    expect(checkRateLimit(bucket, 2, 1000, 1200)).toEqual({ ok: true })
    expect(bucket.count).toBe(1)
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
        normalizeRepository: (value) => value.trim().toLowerCase(),
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents',
        repository: 'Org/Repo',
        state,
        limits,
        now: 2000,
        normalizeRepository: (value) => value.trim().toLowerCase(),
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
        normalizeRepository: (value) => value.trim().toLowerCase(),
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-b',
        repository: 'Org/Repo',
        state: repoState,
        limits: { ...limits, perNamespace: 2 },
        now: 1500,
        normalizeRepository: (value) => value.trim().toLowerCase(),
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
        normalizeRepository: (value) => value.trim().toLowerCase(),
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-b',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 200,
        normalizeRepository: (value) => value.trim().toLowerCase(),
      }),
    ).toEqual({ ok: true })

    expect(
      checkControllerRateLimits({
        namespace: 'agents-c',
        repository: null,
        state: clusterState,
        limits: { ...limits, perNamespace: 3 },
        now: 300,
        normalizeRepository: (value) => value.trim().toLowerCase(),
      }),
    ).toEqual({
      ok: false,
      scope: 'cluster',
      retryAfterSeconds: 60,
      message: 'Cluster rate limit reached',
    })
  })
})
