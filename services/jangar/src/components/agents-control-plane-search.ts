export const DEFAULT_NAMESPACE = 'agents'

export type NamespaceSearchState = {
  namespace: string
  phase?: string
  runtime?: string
}

export const parseNamespaceSearch = (search: Record<string, unknown>): NamespaceSearchState => {
  const runtime = typeof search.runtime === 'string' ? search.runtime.trim() : ''
  const phase = typeof search.phase === 'string' ? search.phase.trim() : ''
  if (typeof search.namespace === 'string') {
    const trimmed = search.namespace.trim()
    if (trimmed.length > 0) {
      return {
        namespace: trimmed,
        ...(runtime.length > 0 ? { runtime } : {}),
        ...(phase.length > 0 ? { phase } : {}),
      }
    }
  }
  return {
    namespace: DEFAULT_NAMESPACE,
    ...(runtime.length > 0 ? { runtime } : {}),
    ...(phase.length > 0 ? { phase } : {}),
  }
}
