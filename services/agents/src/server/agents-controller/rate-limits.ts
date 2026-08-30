import type { RateBucket } from './mutable-state'

export type ControllerRateState = {
  cluster: RateBucket
  perNamespace: Map<string, RateBucket>
  perRepo: Map<string, RateBucket>
}

export type RateLimits = {
  windowSeconds: number
  perNamespace: number
  perRepo: number
  cluster: number
}

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; scope: 'cluster' | 'namespace' | 'repo'; retryAfterSeconds: number; message: string }

export const getRateBucket = (map: Map<string, RateBucket>, key: string) => {
  const existing = map.get(key)
  if (existing) return existing
  const created = { count: 0, resetAt: 0 }
  map.set(key, created)
  return created
}

export const checkRateLimit = (bucket: RateBucket, limit: number, windowMs: number, now: number) => {
  if (limit <= 0) return { ok: true as const }
  if (now >= bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + windowMs
  }
  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    return { ok: false as const, retryAfterSeconds }
  }
  bucket.count += 1
  return { ok: true as const }
}

export const resetControllerRateState = (state: ControllerRateState) => {
  state.cluster.count = 0
  state.cluster.resetAt = 0
  state.perNamespace.clear()
  state.perRepo.clear()
}

export const checkControllerRateLimits = (input: {
  namespace: string
  repository: string | null
  state: ControllerRateState
  limits: RateLimits
  now: number
  normalizeRepository: (value: string) => string
}): RateLimitDecision => {
  const { namespace, repository, state, limits, now, normalizeRepository } = input
  const windowMs = limits.windowSeconds * 1000

  const clusterResult = checkRateLimit(state.cluster, limits.cluster, windowMs, now)
  if (!clusterResult.ok) {
    return {
      ok: false,
      scope: 'cluster',
      retryAfterSeconds: clusterResult.retryAfterSeconds,
      message: 'Cluster rate limit reached',
    }
  }

  const namespaceBucket = getRateBucket(state.perNamespace, namespace)
  const namespaceResult = checkRateLimit(namespaceBucket, limits.perNamespace, windowMs, now)
  if (!namespaceResult.ok) {
    return {
      ok: false,
      scope: 'namespace',
      retryAfterSeconds: namespaceResult.retryAfterSeconds,
      message: `Namespace ${namespace} rate limit reached`,
    }
  }

  if (repository) {
    const repoKey = normalizeRepository(repository)
    const repoBucket = getRateBucket(state.perRepo, repoKey)
    const repoResult = checkRateLimit(repoBucket, limits.perRepo, windowMs, now)
    if (!repoResult.ok) {
      return {
        ok: false,
        scope: 'repo',
        retryAfterSeconds: repoResult.retryAfterSeconds,
        message: `Repository ${repository} rate limit reached`,
      }
    }
  }

  return { ok: true }
}
