import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import {
  buildControlPlaneStatus,
  type ControlPlaneStatusDeps,
  type ControlPlaneStatusOptions,
} from '~/server/control-plane-status'
import type { ControlPlaneStatus } from '~/server/control-plane-status-types'

type ControlPlaneStatusCacheEntry = {
  expiresAtMs: number
  status: ControlPlaneStatus
}

type ControlPlaneStatusInflightEntry = {
  promise: Promise<ControlPlaneStatus>
}

const statusCache = new Map<string, ControlPlaneStatusCacheEntry>()
const statusInflight = new Map<string, ControlPlaneStatusInflightEntry>()

const cacheKeyForStatus = (options: ControlPlaneStatusOptions) =>
  JSON.stringify({
    namespace: options.namespace,
    service: options.service ?? 'jangar',
    grpc: options.grpc,
  })

const pruneStatusCache = (maxEntries: number) => {
  while (statusCache.size > maxEntries) {
    const firstKey = statusCache.keys().next().value
    if (!firstKey) break
    statusCache.delete(firstKey)
  }
}

export const clearControlPlaneStatusCache = () => {
  statusCache.clear()
  statusInflight.clear()
}

export const buildCachedControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const config = resolveControlPlaneStatusConfig(process.env)
  if (config.statusCacheTtlMs <= 0) return buildControlPlaneStatus(options, deps)

  const key = cacheKeyForStatus(options)
  const nowMs = Date.now()
  const cached = statusCache.get(key)
  if (cached && cached.expiresAtMs > nowMs) return cached.status

  const inflight = statusInflight.get(key)
  if (inflight) return inflight.promise

  const promise = buildControlPlaneStatus(options, deps)
    .then((status) => {
      statusCache.set(key, { expiresAtMs: Date.now() + config.statusCacheTtlMs, status })
      pruneStatusCache(config.statusCacheMaxEntries)
      return status
    })
    .finally(() => {
      statusInflight.delete(key)
    })

  statusInflight.set(key, { promise })
  return promise
}
