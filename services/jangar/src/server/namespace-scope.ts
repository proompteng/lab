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

class NamespaceScopeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NamespaceScopeConfigError'
  }
}

const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const isValidDnsLabel = (value: string) => DNS_LABEL_REGEX.test(value)

const validateNamespaces = (namespaces: string[], label: string) => {
  if (namespaces.length === 0) {
    throw new NamespaceScopeConfigError(`[jangar] ${label} namespaces cannot be empty`)
  }

  for (const namespace of namespaces) {
    if (!namespace) {
      throw new NamespaceScopeConfigError(`[jangar] ${label} namespaces cannot contain empty entries`)
    }
    if (namespace.includes('*') && namespace !== '*') {
      throw new NamespaceScopeConfigError(`[jangar] ${label} namespace '${namespace}' must be '*' or a DNS label`)
    }
    if (/\s/.test(namespace)) {
      throw new NamespaceScopeConfigError(`[jangar] ${label} namespace '${namespace}' must not contain whitespace`)
    }
    if (namespace !== '*' && !isValidDnsLabel(namespace)) {
      throw new NamespaceScopeConfigError(`[jangar] ${label} namespace '${namespace}' must be a valid DNS label`)
    }
  }
}

const uniqStable = (values: string[]) => {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    output.push(value)
  }
  return output
}

const parseNamespacesJson = (envName: string, raw: string): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new NamespaceScopeConfigError(`[jangar] invalid ${envName} JSON: ${message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new NamespaceScopeConfigError(`[jangar] ${envName} must be a JSON array of strings`)
  }
  const normalized: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new NamespaceScopeConfigError(`[jangar] ${envName} must be a JSON array of strings`)
    }
    const trimmed = item.trim()
    if (trimmed.length > 0) {
      normalized.push(trimmed)
    }
  }
  return normalized
}

const parseNamespacesCsv = (raw: string) =>
  raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

export const parseNamespaceScopeEnv = (envName: string, options: { fallback: string[]; label: string }): string[] => {
  const raw = process.env[envName]
  if (raw == null) return options.fallback
  if (raw.trim() === '') {
    throw new NamespaceScopeConfigError(
      `[jangar] ${envName} is set but empty; ${options.label} namespaces cannot be empty`,
    )
  }

  const trimmed = raw.trim()
  const namespaces = trimmed.startsWith('[') ? parseNamespacesJson(envName, trimmed) : parseNamespacesCsv(trimmed)
  const unique = uniqStable(namespaces)

  validateNamespaces(unique, options.label)
  assertClusterScopedForWildcard(unique, options.label)
  return unique
}

export const __test = {
  NamespaceScopeConfigError,
  validateNamespaces,
  isValidDnsLabel,
  parseNamespacesCsv,
  parseNamespacesJson,
}
