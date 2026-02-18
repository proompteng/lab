import { readFileSync } from 'node:fs'

// Lightweight helpers shared between the save and retrieve scripts.
export type FlagMap = Record<string, string | true>
type EnvMap = Record<string, string | undefined>

export function parseCliFlags(argv: string[] = []) {
  const flags: FlagMap = {}
  let i = 0

  while (i < argv.length) {
    const token = argv[i]
    if (!token) {
      throw new Error('unexpected missing argument while parsing flags')
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument ${token}; use --key value`)
    }

    const parts = token.slice(2).split('=')
    const key = parts[0]
    if (!key) {
      throw new Error('unexpected empty flag key')
    }

    if (parts.length > 1) {
      flags[key] = parts.slice(1).join('=')
      i += 1
      continue
    }

    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i += 2
      continue
    }

    flags[key] = true
    i += 1
  }

  return flags
}

export const DEFAULT_JANGAR_BASE_URL = 'http://jangar.ide-newton.ts.net'
export const DEFAULT_K8S_JANGAR_BASE_URL = 'http://jangar.jangar.svc.cluster.local'
export const DEFAULT_K8S_SAME_NAMESPACE_JANGAR_BASE_URL = 'http://jangar'

const SERVICEACCOUNT_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

function trimTrailingSlash(raw: string) {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function normalizeNamespace(raw?: string | null) {
  const value = raw?.trim()
  if (!value) {
    return undefined
  }
  return value
}

function readServiceAccountNamespace() {
  try {
    return normalizeNamespace(readFileSync(SERVICEACCOUNT_NAMESPACE_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

function resolveKubernetesNamespace(env: EnvMap, explicitNamespace?: string | null) {
  if (explicitNamespace !== undefined) {
    return normalizeNamespace(explicitNamespace)
  }

  return (
    normalizeNamespace(env.MEMORIES_K8S_NAMESPACE) ??
    normalizeNamespace(env.POD_NAMESPACE) ??
    normalizeNamespace(env.KUBERNETES_NAMESPACE) ??
    readServiceAccountNamespace()
  )
}

export function resolveJangarBaseUrl(options?: { env?: EnvMap; kubernetesNamespace?: string | null }) {
  const env = options?.env ?? process.env
  const configured = env.MEMORIES_JANGAR_URL ?? env.JANGAR_BASE_URL ?? env.MEMORIES_BASE_URL
  if (configured) {
    return trimTrailingSlash(configured)
  }

  const kubernetesNamespace = resolveKubernetesNamespace(env, options?.kubernetesNamespace)
  if (kubernetesNamespace) {
    return kubernetesNamespace.toLowerCase() === 'jangar'
      ? DEFAULT_K8S_SAME_NAMESPACE_JANGAR_BASE_URL
      : DEFAULT_K8S_JANGAR_BASE_URL
  }

  if (env.KUBERNETES_SERVICE_HOST || env.KUBERNETES_SERVICE_PORT) {
    return DEFAULT_K8S_JANGAR_BASE_URL
  }

  return DEFAULT_JANGAR_BASE_URL
}

export function getFlagValue(flags: FlagMap, key: string): string | undefined {
  const raw = flags[key]
  if (typeof raw === 'string' && raw.length > 0) {
    return raw
  }
  if (raw === true) {
    return 'true'
  }
  return undefined
}

export function parseCommaList(input?: string) {
  if (!input) {
    return []
  }
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function parseJson(input?: string) {
  if (!input) {
    return {} as Record<string, unknown>
  }
  try {
    return JSON.parse(input)
  } catch (error) {
    throw new Error(`unable to parse JSON for metadata: ${String(error)}`)
  }
}

export async function readFile(path: string) {
  return await Bun.file(path).text()
}
