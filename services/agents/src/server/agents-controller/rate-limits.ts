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

export type RateLimitBlock = { ok: false; scope: 'cluster' | 'namespace' | 'repo'; retryAt: number; message: string }

export type RateLimitDecision = { ok: true; release: () => void } | RateLimitBlock

type RateLimitInput = {
  namespace: string
  repository: string | null
  state: ControllerRateState
  limits: RateLimits
  now: number
}

const getRetryAt = (bucket: RateBucket | undefined, limit: number, now: number) =>
  limit > 0 && bucket && now < bucket.resetAt && bucket.count >= limit ? bucket.resetAt : null

const consume = (bucket: RateBucket | undefined, windowMs: number, now: number) => {
  // A failed start can release its reservation after a new window has opened.
  if (!bucket || now >= bucket.resetAt || bucket.count === 0) return { count: 1, resetAt: now + windowMs }
  bucket.count += 1
  return bucket
}

const emptyBucket = (): RateBucket => ({ count: 0, resetAt: 0 })

export const resetControllerRateState = (state: ControllerRateState) => {
  state.cluster = emptyBucket()
  state.perNamespace.clear()
  state.perRepo.clear()
}

export const getControllerRateLimitBlock = (input: RateLimitInput): RateLimitBlock | null => {
  const { namespace, repository, state, limits, now } = input
  const clusterRetry = getRetryAt(state.cluster, limits.cluster, now)
  if (clusterRetry !== null) {
    return { ok: false, scope: 'cluster', retryAt: clusterRetry, message: 'Cluster rate limit reached' }
  }

  const namespaceBucket = state.perNamespace.get(namespace)
  const namespaceRetry = getRetryAt(namespaceBucket, limits.perNamespace, now)
  if (namespaceRetry !== null) {
    return {
      ok: false,
      scope: 'namespace',
      retryAt: namespaceRetry,
      message: `Namespace ${namespace} rate limit reached`,
    }
  }

  const repoKey = repository ? normalizeRepository(repository) : ''
  const repoBucket = repoKey ? state.perRepo.get(repoKey) : undefined
  const repoRetry = getRetryAt(repoBucket, limits.perRepo, now)
  if (repoRetry !== null) {
    return {
      ok: false,
      scope: 'repo',
      retryAt: repoRetry,
      message: `Repository ${repository} rate limit reached`,
    }
  }
  return null
}

export const reserveControllerRateLimit = (input: RateLimitInput): RateLimitDecision => {
  // Recheck and reserve all scopes synchronously; a preflight check does not grant a slot.
  const blocked = getControllerRateLimitBlock(input)
  if (blocked) return blocked
  const { namespace, repository, state, limits, now } = input
  const windowMs = limits.windowSeconds * 1000
  const reserved: RateBucket[] = []
  if (limits.cluster > 0) {
    state.cluster = consume(state.cluster, windowMs, now)
    reserved.push(state.cluster)
  }
  if (limits.perNamespace > 0) {
    const bucket = consume(state.perNamespace.get(namespace), windowMs, now)
    state.perNamespace.set(namespace, bucket)
    reserved.push(bucket)
  }
  const repoKey = repository ? normalizeRepository(repository) : ''
  if (repoKey && limits.perRepo > 0) {
    const bucket = consume(state.perRepo.get(repoKey), windowMs, now)
    state.perRepo.set(repoKey, bucket)
    reserved.push(bucket)
  }
  return {
    ok: true,
    release: () => {
      for (const bucket of reserved) bucket.count -= 1
      reserved.length = 0
    },
  }
}
