import { parseBooleanEnv, readAgentsEnv, readAgentsRawEnv, type EnvSource } from './runtime-env'

const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const isControllerClusterScoped = (env: EnvSource = process.env) =>
  parseBooleanEnv(readAgentsEnv(env, 'AGENTS_RBAC_CLUSTER_SCOPED'), false)

export const assertClusterScopedForWildcard = (namespaces: string[], label: string, env: EnvSource = process.env) => {
  if (!namespaces.includes('*')) return
  if (isControllerClusterScoped(env)) return
  throw new NamespaceScopeConfigError(`[agents] ${label} namespaces '*' require rbac.clusterScoped=true`)
}

class NamespaceScopeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NamespaceScopeConfigError'
  }
}

const isValidDnsLabel = (value: string) => DNS_LABEL_REGEX.test(value)

const validateNamespaces = (namespaces: string[], label: string) => {
  if (namespaces.length === 0) {
    throw new NamespaceScopeConfigError(`[agents] ${label} namespaces cannot be empty`)
  }

  for (const namespace of namespaces) {
    if (!namespace) {
      throw new NamespaceScopeConfigError(`[agents] ${label} namespaces cannot contain empty entries`)
    }
    if (namespace.includes('*') && namespace !== '*') {
      throw new NamespaceScopeConfigError(`[agents] ${label} namespace '${namespace}' must be '*' or a DNS label`)
    }
    if (/\s/.test(namespace)) {
      throw new NamespaceScopeConfigError(`[agents] ${label} namespace '${namespace}' must not contain whitespace`)
    }
    if (namespace !== '*' && !isValidDnsLabel(namespace)) {
      throw new NamespaceScopeConfigError(`[agents] ${label} namespace '${namespace}' must be a valid DNS label`)
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
    throw new NamespaceScopeConfigError(`[agents] invalid ${envName} JSON: ${message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new NamespaceScopeConfigError(`[agents] ${envName} must be a JSON array of strings`)
  }
  const normalized: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new NamespaceScopeConfigError(`[agents] ${envName} must be a JSON array of strings`)
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

export const parseNamespaceScopeEnv = (
  envName: string,
  options: { fallback: string[]; label: string },
  env: EnvSource = process.env,
): string[] => {
  const raw = readAgentsRawEnv(env, envName)
  if (raw == null) return options.fallback
  if (raw.trim() === '') {
    throw new NamespaceScopeConfigError(
      `[agents] ${envName} is set but empty; ${options.label} namespaces cannot be empty`,
    )
  }

  const trimmed = raw.trim()
  const namespaces = trimmed.startsWith('[') ? parseNamespacesJson(envName, trimmed) : parseNamespacesCsv(trimmed)
  const unique = uniqStable(namespaces)

  validateNamespaces(unique, options.label)
  assertClusterScopedForWildcard(unique, options.label, env)
  return unique
}

export const __test = {
  NamespaceScopeConfigError,
  validateNamespaces,
  isValidDnsLabel,
  parseNamespacesCsv,
  parseNamespacesJson,
}
