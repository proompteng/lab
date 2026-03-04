import { createFileRoute } from '@tanstack/react-router'
import { type AgentPrimitiveKind, resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient, type KubernetesClient } from '~/server/primitives-kube'
import { createControlPlaneCacheStore } from '~/server/control-plane-cache-store'
import {
  buildCacheFreshnessState,
  cacheStateToResponse,
  resolveCacheFreshnessConfig,
} from '~/server/control-plane-cache-freshness'

export const Route = createFileRoute('/api/agents/control-plane/summary')({
  server: {
    handlers: {
      GET: async ({ request }) => getControlPlaneSummary(request),
    },
  },
})

const SUMMARY_KINDS: AgentPrimitiveKind[] = [
  'Agent',
  'AgentRun',
  'Orchestration',
  'OrchestrationRun',
  'ImplementationSpec',
  'ImplementationSource',
  'Memory',
  'Tool',
  'Signal',
  'Schedule',
  'Swarm',
  'Artifact',
  'Workspace',
]

const RUN_PHASES = ['Pending', 'Running', 'Succeeded', 'Failed', 'Cancelled'] as const

type RunPhase = (typeof RUN_PHASES)[number] | 'Unknown' | string

type CacheSummaryState = ReturnType<typeof cacheStateToResponse> & {
  stale_count: number
  oldest_age_seconds: number
}

type SummaryEntry = {
  total: number
  error?: string
  phases?: Record<RunPhase, number>
  cache?: CacheSummaryState
}

const buildPhaseCounts = (): Record<RunPhase, number> => ({
  Pending: 0,
  Running: 0,
  Succeeded: 0,
  Failed: 0,
  Cancelled: 0,
  Unknown: 0,
})

const SUMMARY_CACHE_KINDS = new Set<AgentPrimitiveKind>([
  'Agent',
  'AgentRun',
  'ImplementationSpec',
  'ImplementationSource',
])

const isCacheEnabled = () => {
  const flag = (process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on'
}

const buildCacheMetadata = (
  freshnessStates: ReturnType<typeof buildCacheFreshnessState>[],
  cacheCheckedAt: Date,
  cacheConfig: ReturnType<typeof resolveCacheFreshnessConfig>,
) => {
  if (freshnessStates.length === 0) {
    const representative = buildCacheFreshnessState(cacheCheckedAt, cacheCheckedAt, cacheConfig)
    return {
      ...cacheStateToResponse(representative),
      stale_count: 0,
      oldest_age_seconds: 0,
    }
  }

  const staleCount = freshnessStates.filter((state) => state.isStale).length
  const oldestAgeSeconds = freshnessStates.reduce((max, state) => {
    if (state.ageSeconds == null) return max
    return Math.max(max, state.ageSeconds)
  }, 0)
  const representative = freshnessStates[0]

  return {
    ...cacheStateToResponse({
      ...representative,
      isFresh: staleCount === 0,
      isStale: staleCount > 0,
      stale: staleCount > 0,
    }),
    stale_count: staleCount,
    oldest_age_seconds: oldestAgeSeconds,
  }
}

const countRunPhases = (items: unknown[]): Record<RunPhase, number> => {
  const phases = buildPhaseCounts()

  for (const item of items) {
    const record = asRecord(item) ?? {}
    const status = asRecord(record.status) ?? {}
    const phase = asString(status.phase) ?? 'Unknown'
    if (!(phase in phases)) {
      phases[phase] = 0
    }
    phases[phase] += 1
  }

  return phases
}

export const getControlPlaneSummary = async (
  request: Request,
  deps: {
    kubeClient?: Pick<KubernetesClient, 'list'>
    cacheStoreFactory?: typeof createControlPlaneCacheStore
  } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const kube = deps.kubeClient ?? createKubernetesClient()
  const cacheStoreFactory = deps.cacheStoreFactory ?? createControlPlaneCacheStore

  let cacheStore: ReturnType<typeof createControlPlaneCacheStore> | null = null
  const getCacheStore = async () => {
    if (cacheStore) return cacheStore
    cacheStore = cacheStoreFactory()
    await cacheStore.ready
    return cacheStore
  }

  const cacheEnabled = isCacheEnabled()
  const cacheConfig = cacheEnabled ? resolveCacheFreshnessConfig() : null
  const cacheCheckedAt = new Date()

  const resources = {} as Record<AgentPrimitiveKind, SummaryEntry>

  for (const kind of SUMMARY_KINDS) {
    const resolved = resolvePrimitiveKind(kind)
    if (!resolved) {
      resources[kind] = { total: 0, error: `Unknown kind: ${kind}` }
      continue
    }

    const canUseCache = cacheEnabled && SUMMARY_CACHE_KINDS.has(resolved.kind)
    if (canUseCache) {
      if (!cacheConfig) {
        resources[resolved.kind] = { total: 0, error: 'cache config unavailable' }
        continue
      }
      try {
        const store = await getCacheStore()
        const result = await store.listResources({
          cluster: (process.env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER ?? 'default').trim() || 'default',
          kind: resolved.kind,
          namespace,
        })
        const freshness = result.items.map((item) =>
          buildCacheFreshnessState(item.lastSeenAt, cacheCheckedAt, cacheConfig),
        )
        const staleCount = freshness.filter((state) => state.isStale).length
        if (staleCount > 0 && !cacheConfig.allowStale) {
          throw new Error('cache stale')
        }

        const items = result.items.map((item) => item.resource as Record<string, unknown>)
        const entry: SummaryEntry = {
          total: result.total,
          cache: buildCacheMetadata(freshness, cacheCheckedAt, cacheConfig),
        }
        if (resolved.kind === 'AgentRun' || resolved.kind === 'OrchestrationRun') {
          entry.phases = countRunPhases(items)
        }
        resources[resolved.kind] = entry
        continue
      } catch {
        // Fall back to kubernetes list when cache is unavailable or stale and strict mode is on.
      }
    }

    try {
      const list = await kube.list(resolved.resource, namespace)
      const items = Array.isArray(list.items) ? list.items : []
      const entry: SummaryEntry = { total: items.length }
      if (resolved.kind === 'AgentRun' || resolved.kind === 'OrchestrationRun') {
        entry.phases = countRunPhases(items)
      }
      resources[resolved.kind] = entry
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const entry: SummaryEntry = { total: 0, error: message }
      if (resolved.kind === 'AgentRun' || resolved.kind === 'OrchestrationRun') {
        entry.phases = buildPhaseCounts()
      }
      resources[resolved.kind] = entry
    }
  }

  if (cacheStore) {
    try {
      await cacheStore.close()
    } catch {
      // ignore
    }
  }

  return okResponse({ ok: true, namespace, resources })
}
