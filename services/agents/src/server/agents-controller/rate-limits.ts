import { normalizeRepository } from './run-utils'

type RateBucket = { count: number; resetAt: number }

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

const getRetryAfter = (bucket: RateBucket | undefined, limit: number, now: number) => {
  if (limit <= 0 || !bucket || now >= bucket.resetAt || bucket.count < limit) return 0
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
}

const consume = (bucket: RateBucket, windowMs: number, now: number) => {
  if (now >= bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + windowMs
  }
  bucket.count += 1
  return bucket
}

const emptyBucket = (): RateBucket => ({ count: 0, resetAt: 0 })

export const resetControllerRateState = (state: ControllerRateState) => {
  state.cluster = emptyBucket()
  state.perNamespace.clear()
  state.perRepo.clear()
}

export const checkControllerRateLimits = (input: {
  namespace: string
  repository: string | null
  state: ControllerRateState
  limits: RateLimits
  now: number
}): RateLimitDecision => {
  const { namespace, repository, state, limits, now } = input
  const clusterRetry = getRetryAfter(state.cluster, limits.cluster, now)
  if (clusterRetry) {
    return { ok: false, scope: 'cluster', retryAfterSeconds: clusterRetry, message: 'Cluster rate limit reached' }
  }

  const namespaceBucket = state.perNamespace.get(namespace)
  const namespaceRetry = getRetryAfter(namespaceBucket, limits.perNamespace, now)
  if (namespaceRetry) {
    return {
      ok: false,
      scope: 'namespace',
      retryAfterSeconds: namespaceRetry,
      message: `Namespace ${namespace} rate limit reached`,
    }
  }

  const repoKey = repository ? normalizeRepository(repository) : ''
  const repoBucket = repoKey ? state.perRepo.get(repoKey) : undefined
  const repoRetry = getRetryAfter(repoBucket, limits.perRepo, now)
  if (repoRetry) {
    return {
      ok: false,
      scope: 'repo',
      retryAfterSeconds: repoRetry,
      message: `Repository ${repository} rate limit reached`,
    }
  }

  // Only attempts allowed by all scopes consume the shared budget.
  const windowMs = limits.windowSeconds * 1000
  if (limits.cluster > 0) consume(state.cluster, windowMs, now)
  if (limits.perNamespace > 0)
    state.perNamespace.set(namespace, consume(namespaceBucket ?? emptyBucket(), windowMs, now))
  if (repoKey && limits.perRepo > 0) state.perRepo.set(repoKey, consume(repoBucket ?? emptyBucket(), windowMs, now))
  return { ok: true }
}
