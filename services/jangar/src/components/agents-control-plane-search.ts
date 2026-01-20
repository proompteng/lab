export const DEFAULT_NAMESPACE = 'jangar'

export type NamespaceSearchState = {
  namespace: string
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
