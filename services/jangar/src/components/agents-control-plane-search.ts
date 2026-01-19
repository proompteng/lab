export const DEFAULT_NAMESPACE = 'agents'

export type NamespaceSearchState = {
  namespace: string
}

export const parseNamespaceSearch = (search: Record<string, unknown>): NamespaceSearchState => ({
  namespace:
    typeof search.namespace === 'string' && search.namespace.trim().length > 0 ? search.namespace : DEFAULT_NAMESPACE,
})
