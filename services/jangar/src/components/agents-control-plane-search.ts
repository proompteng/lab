export const DEFAULT_NAMESPACE = 'agents'

export type NamespaceSearchState = {
  namespace: string
  labelSelector?: string
  spec?: string
}

export type AgentRunsSearchState = {
  namespace: string
  labelSelector?: string
  phase?: string
  runtime?: string
}

const parseOptionalFilter = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const parseNamespaceSearch = (search: Record<string, unknown>): NamespaceSearchState => {
  const namespaceValue =
    typeof search.namespace === 'string' && search.namespace.trim().length > 0
      ? search.namespace.trim()
      : DEFAULT_NAMESPACE
  const labelSelector =
    parseOptionalFilter(search.labelSelector) ?? parseOptionalFilter(search.label_selector ?? search.labelSelector)
  const spec = parseOptionalFilter(search.spec)
  return { namespace: namespaceValue, ...(labelSelector ? { labelSelector } : {}), ...(spec ? { spec } : {}) }
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
