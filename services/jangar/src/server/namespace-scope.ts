const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const isClusterScoped = () => parseBooleanEnv(process.env.JANGAR_RBAC_CLUSTER_SCOPED, false)

export const assertClusterScopedForWildcard = (namespaces: string[], label: string) => {
  if (!namespaces.includes('*')) return
  if (isClusterScoped()) return
  throw new Error(`[jangar] ${label} namespaces '*' require rbac.clusterScoped=true`)
}
