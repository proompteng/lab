import { createFileRoute, type AgentsServerRouteArgs } from '../../../../server/server-route'

import {
  buildCacheFreshnessState,
  cacheStateToResponse,
  resolveCacheFreshnessConfig,
} from '../../../../server/control-plane-cache-freshness'
import { createControlPlaneCacheStore } from '../../../../server/control-plane-cache-store'
import { resolveControlPlaneCacheReadConfig } from '../../../../server/control-plane-cache-config'
import { resolvePrimitiveKind } from '../../../../server/control-plane-primitive-kinds'
import { errorResponse, okResponse } from '../../../../server/http'
import { createKubernetesClient, type KubernetesClient } from '../../../../server/kube-types'
import { asRecord, asString, normalizeNamespace } from '../../../../server/primitives'
import { createKubectlWatchStream } from '../../../../server/primitives-watch'

export const Route = createFileRoute('/api/agents/control-plane/resources')({
  server: {
    handlers: {
      GET: async ({ request }: AgentsServerRouteArgs) => listPrimitiveResources(request),
    },
  },
})

const CACHE_KINDS = new Set([
  'Agent',
  'AgentRun',
  'AgentProvider',
  'ImplementationSpec',
  'ImplementationSource',
  'VersionControlProvider',
])

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 500)
}

const parseFilter = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseLabelSelectorEquals = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parts = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (parts.length === 0) return null

  const filters: Array<{ key: string; value: string }> = []
  for (const part of parts) {
    if (part.includes('!=') || part.includes(' in ') || part.includes(' notin ') || part.includes('(')) {
      return null
    }
    const operatorIndex = part.indexOf('=')
    if (operatorIndex <= 0) return null
    const key = part.slice(0, operatorIndex).trim()
    const rawValue = part.slice(operatorIndex + 1).trim()
    if (!key || !rawValue) return null
    filters.push({ key, value: rawValue })
  }

  return filters.length > 0 ? filters : null
}

const parseStream = (value: string | null) => value === 'true' || value === '1'

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string | null, runtime?: string | null) => {
  if (phase) {
    const status = asRecord(resource.status) ?? {}
    const itemPhase = asString(status.phase)
    if (itemPhase !== phase) return false
  }
  if (runtime) {
    const spec = asRecord(resource.spec) ?? {}
    const runtimeSpec = asRecord(spec.runtime) ?? {}
    const runtimeType = asString(runtimeSpec.type)
    if (runtimeType !== runtime) return false
  }
  return true
}

const isCacheEnabled = () => resolveControlPlaneCacheReadConfig(process.env).enabled

const buildCacheResponse = (
  state: ReturnType<typeof buildCacheFreshnessState>,
  params: {
    stale_count?: number
    oldest_age_seconds?: number
    cache_fallback?: {
      reason: string
      replacement: string
    }
  } = {},
) => ({
  ...cacheStateToResponse(state),
  ...(params.stale_count !== undefined ? { stale_count: params.stale_count } : {}),
  ...(params.oldest_age_seconds !== undefined ? { oldest_age_seconds: params.oldest_age_seconds } : {}),
  ...(params.cache_fallback
    ? {
        cache_fallback: {
          source: 'control-plane-cache',
          ...params.cache_fallback,
        },
      }
    : {}),
})

export const listPrimitiveResources = async (
  request: Request,
  deps: {
    kubeClient?: KubernetesClient
    cacheStoreFactory?: typeof createControlPlaneCacheStore
  } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const limit = parseLimit(url.searchParams.get('limit'))
  const labelSelectorRaw =
    parseFilter(url.searchParams.get('labelSelector')) ?? parseFilter(url.searchParams.get('label_selector'))
  const labelEquals = parseLabelSelectorEquals(labelSelectorRaw)
  const phase = parseFilter(url.searchParams.get('phase'))
  const runtime = parseFilter(url.searchParams.get('runtime'))
  const kube = deps.kubeClient ?? createKubernetesClient()
  const stream = parseStream(url.searchParams.get('stream'))

  try {
    if (stream) {
      const args = ['get', resolved.resource, '-n', namespace, '-o', 'json', '--watch', '--output-watch-events']
      if (labelSelectorRaw) {
        args.push('-l', labelSelectorRaw)
      }
      return createKubectlWatchStream({
        request,
        args,
        onEvent: (event) => {
          const summary = toSummary(asRecord(event.object) ?? {})
          if (resolved.kind === 'AgentRun' && event.type !== 'DELETED') {
            if (!matchesAgentRunFilters(summary, phase, runtime)) return null
          }
          const metadata = asRecord(summary.metadata) ?? {}
          return {
            type: event.type,
            kind: resolved.kind,
            namespace,
            name: asString(metadata.name),
            resource: summary,
          }
        },
      })
    }

    const canUseCache =
      isCacheEnabled() &&
      CACHE_KINDS.has(resolved.kind) &&
      (labelSelectorRaw == null || (labelEquals != null && labelEquals.length > 0))

    let fallbackCacheMetadata: ReturnType<typeof buildCacheResponse> | null = null

    if (canUseCache) {
      const cluster = resolveControlPlaneCacheReadConfig(process.env).clusterId
      const cacheCheckedAt = new Date()
      const cacheConfig = resolveCacheFreshnessConfig()
      let store: ReturnType<typeof createControlPlaneCacheStore> | null = null
      try {
        store = (deps.cacheStoreFactory ?? createControlPlaneCacheStore)()
        await store.ready
        const result = await store.listResources({
          cluster,
          kind: resolved.kind,
          namespace,
          labelEquals: labelEquals ?? undefined,
          phase,
          runtime,
          limit,
        })
        const freshnessStates = result.items.map((item) =>
          buildCacheFreshnessState(item.lastSeenAt, cacheCheckedAt, cacheConfig),
        )
        const staleCount = freshnessStates.filter((state) => state.isStale).length
        const oldestAgeSeconds = freshnessStates.reduce((max, state) => {
          if (state.ageSeconds == null) return max
          return Math.max(max, state.ageSeconds)
        }, 0)

        const representative = freshnessStates[0] ?? buildCacheFreshnessState(null, cacheCheckedAt, cacheConfig)
        const shouldFallback = staleCount > 0 && !cacheConfig.allowStale
        const cacheState = buildCacheResponse(
          {
            ...representative,
            isFresh: staleCount === 0,
            isStale: staleCount > 0,
            stale: staleCount > 0,
          },
          {
            stale_count: staleCount,
            oldest_age_seconds: oldestAgeSeconds,
            ...(shouldFallback
              ? {
                  cache_fallback: {
                    reason: 'stale_cache_fallback_disabled',
                    replacement: 'live-read',
                  },
                }
              : {}),
          },
        )

        if (shouldFallback) {
          console.warn('[agents][control-plane-cache] stale cache list detected, falling back to live list', {
            kind: resolved.kind,
            namespace,
            total: result.total,
            stale_count: staleCount,
            oldest_age_seconds: oldestAgeSeconds,
          })
          fallbackCacheMetadata = cacheState
        } else {
          return okResponse({
            ok: true,
            kind: resolved.kind,
            namespace,
            total: result.total,
            items: result.items.map((item) => item.resource),
            cache: cacheState,
          })
        }
      } catch {
        // Fall back to a live Kubernetes list for unsupported selectors or transient DB issues.
      } finally {
        try {
          await store?.close()
        } catch {
          // ignore
        }
      }
    }

    const list = await kube.list(resolved.resource, namespace, labelSelectorRaw ?? undefined)
    const itemsRaw = Array.isArray(list.items) ? list.items : []
    const summaries = itemsRaw.map((item) => toSummary(asRecord(item) ?? {}))
    const filtered =
      resolved.kind === 'AgentRun' && (phase || runtime)
        ? summaries.filter((item) => matchesAgentRunFilters(item, phase, runtime))
        : summaries
    const sliced = limit ? filtered.slice(0, limit) : filtered
    return okResponse({
      ok: true,
      kind: resolved.kind,
      namespace,
      total: filtered.length,
      items: sliced,
      ...(fallbackCacheMetadata ? { cache: fallbackCacheMetadata } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace })
  }
}
