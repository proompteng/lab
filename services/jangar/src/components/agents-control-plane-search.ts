export const DEFAULT_NAMESPACE = 'agents'

export type NamespaceSearchState = {
  namespace: string
}

export type AgentRunsSearchState = {
  namespace: string
  phase?: string
  runtime?: string
}

export const parseNamespaceSearch = (search: Record<string, unknown>): NamespaceSearchState => {
  if (typeof search.namespace === 'string') {
    const trimmed = search.namespace.trim()
    if (trimmed.length > 0) {
      return { namespace: trimmed }
    }
  }
  return { namespace: DEFAULT_NAMESPACE }
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
    phase: parseOptionalFilter(search.phase),
    runtime: parseOptionalFilter(search.runtime),
  }
}
