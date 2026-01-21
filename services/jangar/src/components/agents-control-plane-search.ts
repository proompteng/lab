export const DEFAULT_NAMESPACE = 'agents'

export type NamespaceSearchState = {
  namespace: string
  labelSelector?: string
}

export type AgentRunsSearchState = {
  namespace: string
  labelSelector?: string
  phase?: string
  runtime?: string
}

export const parseNamespaceSearch = (search: Record<string, unknown>): NamespaceSearchState => {
  const namespace = typeof search.namespace === 'string' ? search.namespace.trim() : ''
  const labelSelector = parseOptionalFilter(search.labelSelector)
  if (namespace.length > 0) {
    return { namespace, ...(labelSelector ? { labelSelector } : {}) }
  }
  return { namespace: DEFAULT_NAMESPACE, ...(labelSelector ? { labelSelector } : {}) }
}

const parseOptionalFilter = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const parseAgentRunsSearch = (search: Record<string, unknown>): AgentRunsSearchState => {
  const base = parseNamespaceSearch(search)
  return {
    namespace: base.namespace,
    labelSelector: base.labelSelector,
    phase: parseOptionalFilter(search.phase),
    runtime: parseOptionalFilter(search.runtime),
  }
}
