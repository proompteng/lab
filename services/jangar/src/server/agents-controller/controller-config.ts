import { spawn } from 'node:child_process'

import { parseBooleanEnv, parseEnvRecord, parseNumberEnv, parseOptionalNumber } from './env-config'
import { normalizeRepositoryKey, type RepoConcurrencyConfig } from './queue-state'

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

export const parseRepoConcurrency = (): RepoConcurrencyConfig => {
  const enabled = parseBooleanEnv(
    process.env.JANGAR_AGENTS_CONTROLLER_REPO_CONCURRENCY_ENABLED,
    DEFAULT_REPO_CONCURRENCY.enabled,
  )
  const parsedDefault = parseOptionalNumber(process.env.JANGAR_AGENTS_CONTROLLER_REPO_CONCURRENCY_DEFAULT)
  const defaultLimit =
    parsedDefault === undefined || parsedDefault < 0 ? DEFAULT_REPO_CONCURRENCY.defaultLimit : Math.floor(parsedDefault)
  return {
    enabled,
    defaultLimit,
    overrides: parseRepoConcurrencyOverrides(),
  }
}

export const parseConcurrency = () => ({
  perNamespace: parseNumberEnv(
    process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE,
    DEFAULT_CONCURRENCY.perNamespace,
    1,
  ),
  perAgent: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT, DEFAULT_CONCURRENCY.perAgent, 1),
  cluster: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER, DEFAULT_CONCURRENCY.cluster, 1),
  repoConcurrency: parseRepoConcurrency(),
})

export const parseQueueLimits = () => ({
  perNamespace: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE, DEFAULT_QUEUE_LIMITS.perNamespace),
  perRepo: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_REPO, DEFAULT_QUEUE_LIMITS.perRepo),
  cluster: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER, DEFAULT_QUEUE_LIMITS.cluster),
})

export const parseRateLimits = () => ({
  windowSeconds: parseNumberEnv(
    process.env.JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS,
    DEFAULT_RATE_LIMITS.windowSeconds,
    1,
  ),
  perNamespace: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE, DEFAULT_RATE_LIMITS.perNamespace),
  perRepo: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_REPO, DEFAULT_RATE_LIMITS.perRepo),
  cluster: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER, DEFAULT_RATE_LIMITS.cluster),
})

export const runKubectl = (args: string[]) =>
  new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const command = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    command.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    command.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    command.on('close', (code) => resolve({ stdout, stderr, code }))
  })

export const checkCrds = async (options: {
  resolveRequiredCrds: () => string[]
  resolveCrdCheckNamespace: () => string
  nowIso: () => string
}) => {
  const requiredCrds = options.resolveRequiredCrds()
  const crdResult = await runKubectl(['get', 'crd', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}'])
  const missing: string[] = []
  const forbidden: string[] = []
  if (crdResult.code !== 0) {
    const details = (crdResult.stderr || crdResult.stdout || '').toLowerCase()
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
  const availableCrds = new Set(
    crdResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  for (const name of requiredCrds) {
    if (!availableCrds.has(name)) {
      missing.push(name)
    }
  }

  const namespace = options.resolveCrdCheckNamespace()
  const serviceResult = await runKubectl(['get', 'svc', '-n', namespace, 'nats', '-o', 'name'])
  if (serviceResult.code !== 0) {
    return {
      ok: false,
      missing: [...missing, `service:nats@${namespace}`],
      checkedAt: options.nowIso(),
    }
  }

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing: [...missing, ...forbidden],
    checkedAt: options.nowIso(),
  }
}
