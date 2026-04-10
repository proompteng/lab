import { createKubeGateway, type KubeGateway } from '~/server/kube-gateway'
import { parseBooleanEnv, parseEnvRecord, parseNumberEnv, parseOptionalNumber } from './env-config'
import { normalizeRepositoryKey, type RepoConcurrencyConfig } from './queue-state'

type EnvSource = Record<string, string | undefined>

const DEFAULT_CONCURRENCY = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
}
const DEFAULT_QUEUE_LIMITS = {
  perNamespace: 200,
  perRepo: 50,
  cluster: 1000,
}
const DEFAULT_RATE_LIMITS = {
  windowSeconds: 60,
  perNamespace: 120,
  perRepo: 30,
  cluster: 600,
}
const DEFAULT_REPO_CONCURRENCY = {
  enabled: false,
  defaultLimit: 0,
}

export const parseRepoConcurrencyOverrides = () => {
  const rawOverrides = parseEnvRecord('JANGAR_AGENTS_CONTROLLER_REPO_CONCURRENCY_OVERRIDES') ?? {}
  const overrides = new Map<string, number>()
  for (const [repo, rawLimit] of Object.entries(rawOverrides)) {
    const parsed = parseOptionalNumber(rawLimit)
    if (parsed === undefined || parsed <= 0) continue
    overrides.set(normalizeRepositoryKey(repo), Math.floor(parsed))
  }
  return overrides
}

export const parseRepoConcurrency = (env: EnvSource = process.env): RepoConcurrencyConfig => {
  const enabled = parseBooleanEnv(
    env.JANGAR_AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED,
    DEFAULT_REPO_CONCURRENCY.enabled,
  )
  const parsedDefault = parseOptionalNumber(env.JANGAR_AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT)
  const defaultLimit =
    parsedDefault === undefined || parsedDefault < 0 ? DEFAULT_REPO_CONCURRENCY.defaultLimit : Math.floor(parsedDefault)
  return {
    enabled,
    defaultLimit,
    overrides: parseRepoConcurrencyOverrides(),
  }
}

export const parseConcurrency = (env: EnvSource = process.env) => ({
  perNamespace: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE, DEFAULT_CONCURRENCY.perNamespace, 1),
  perAgent: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT, DEFAULT_CONCURRENCY.perAgent, 1),
  cluster: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER, DEFAULT_CONCURRENCY.cluster, 1),
  repoConcurrency: parseRepoConcurrency(env),
})

export const parseQueueLimits = (env: EnvSource = process.env) => ({
  perNamespace: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE, DEFAULT_QUEUE_LIMITS.perNamespace),
  perRepo: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_QUEUE_REPO, DEFAULT_QUEUE_LIMITS.perRepo),
  cluster: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER, DEFAULT_QUEUE_LIMITS.cluster),
})

export const parseRateLimits = (env: EnvSource = process.env) => ({
  windowSeconds: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS, DEFAULT_RATE_LIMITS.windowSeconds, 1),
  perNamespace: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE, DEFAULT_RATE_LIMITS.perNamespace),
  perRepo: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_RATE_REPO, DEFAULT_RATE_LIMITS.perRepo),
  cluster: parseNumberEnv(env.JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER, DEFAULT_RATE_LIMITS.cluster),
})

const DEFAULT_AGENTRUN_IDEMPOTENCY_RESERVATION_TTL_SECONDS = 10 * 60

const parseAdmissionNamespaces = (namespace: string, env: EnvSource) => {
  const raw = env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  if (!raw) return { namespaces: [namespace], includeCluster: true }
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (list.length === 0) return { namespaces: [namespace], includeCluster: true }
  if (list.includes('*')) {
    return { namespaces: [namespace], includeCluster: false }
  }
  return { namespaces: list, includeCluster: true }
}

export type AgentRunAdmissionConfig = {
  vcsProvidersEnabled: boolean
  idempotencyEnabled: boolean
  idempotencyReservationTtlSeconds: number
  admissionNamespaces: {
    namespaces: string[]
    includeCluster: boolean
  }
  concurrency: {
    perNamespace: number
    cluster: number
  }
  queue: {
    perNamespace: number
    perRepo: number
    cluster: number
  }
  rate: {
    windowSeconds: number
    perNamespace: number
    perRepo: number
    cluster: number
  }
}

export const resolveAgentRunAdmissionConfig = (
  namespace: string,
  env: EnvSource = process.env,
): AgentRunAdmissionConfig => ({
  vcsProvidersEnabled: parseBooleanEnv(env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true),
  idempotencyEnabled: parseBooleanEnv(env.JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED, true),
  idempotencyReservationTtlSeconds: parseNumberEnv(
    env.JANGAR_AGENTRUN_IDEMPOTENCY_RESERVATION_TTL_SECONDS,
    DEFAULT_AGENTRUN_IDEMPOTENCY_RESERVATION_TTL_SECONDS,
    0,
  ),
  admissionNamespaces: parseAdmissionNamespaces(namespace, env),
  concurrency: (() => {
    const config = parseConcurrency(env)
    return { perNamespace: config.perNamespace, cluster: config.cluster }
  })(),
  queue: parseQueueLimits(env),
  rate: parseRateLimits(env),
})

type NatsDependency = {
  enabled: boolean
  url?: string
}

type KubernetesServiceReference = {
  name: string
  namespace: string
}

export const resolveKubernetesServiceReferenceFromUrl = (
  url: string | undefined,
  fallbackNamespace: string,
): KubernetesServiceReference | null => {
  const raw = url?.trim()
  if (!raw) return null

  let hostname: string
  try {
    hostname = new URL(raw).hostname.trim().toLowerCase()
  } catch {
    return null
  }

  if (!hostname) return null

  const parts = hostname.split('.').filter(Boolean)
  if (parts.length === 1) {
    return {
      name: parts[0]!,
      namespace: fallbackNamespace,
    }
  }

  if (parts.length === 2) {
    return {
      name: parts[0]!,
      namespace: parts[1]!,
    }
  }

  if (parts[2] === 'svc') {
    return {
      name: parts[0]!,
      namespace: parts[1]!,
    }
  }

  return null
}

export const checkCrds = async (options: {
  resolveRequiredCrds: () => string[]
  resolveCrdCheckNamespace: () => string
  nowIso: () => string
  resolveNatsDependency?: () => NatsDependency
  kubeGateway?: Pick<KubeGateway, 'listCustomResourceDefinitions' | 'serviceExists'>
}) => {
  const kubeGateway = options.kubeGateway ?? createKubeGateway()
  const requiredCrds = options.resolveRequiredCrds()
  const missing: string[] = []
  const forbidden: string[] = []
  let availableCrds = new Set<string>()
  try {
    availableCrds = new Set(await kubeGateway.listCustomResourceDefinitions())
  } catch (error) {
    const details = (error instanceof Error ? error.message : String(error)).toLowerCase()
    if (details.includes('forbidden') || details.includes('unauthorized')) {
      forbidden.push(...requiredCrds)
    } else {
      missing.push(...requiredCrds)
    }
    return {
      ok: false,
      missing: [...missing, ...forbidden],
      checkedAt: options.nowIso(),
    }
  }
  for (const name of requiredCrds) {
    if (!availableCrds.has(name)) {
      missing.push(name)
    }
  }

  const namespace = options.resolveCrdCheckNamespace()
  const natsDependency = options.resolveNatsDependency?.()
  if (natsDependency?.enabled) {
    const serviceReference = resolveKubernetesServiceReferenceFromUrl(natsDependency.url, namespace)
    if (serviceReference) {
      const serviceExists = await kubeGateway
        .serviceExists(serviceReference.namespace, serviceReference.name)
        .catch(() => false)
      if (!serviceExists) {
        return {
          ok: false,
          missing: [...missing, `service:${serviceReference.name}@${serviceReference.namespace}`],
          checkedAt: options.nowIso(),
        }
      }
    }
  }

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing: [...missing, ...forbidden],
    checkedAt: options.nowIso(),
  }
}
