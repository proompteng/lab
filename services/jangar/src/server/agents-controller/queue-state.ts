import { asString, readNested } from '~/server/primitives-http'

import type { ControllerState } from './namespace-state'
import { isQueuedRun, normalizeRepository, resolveRunRepository } from './run-utils'

export type { ControllerState } from './namespace-state'

export type RepoConcurrencyConfig = {
  enabled: boolean
  defaultLimit: number
  overrides: Map<string, number>
}

export const normalizeRepositoryKey = (value: string) => value.trim().toLowerCase()

export const buildInFlightCounts = (state: ControllerState, namespace: string) => {
  const perAgent = new Map<string, number>()
  const perRepository = new Map<string, number>()
  let total = 0
  let cluster = 0
  for (const [ns, nsState] of state.namespaces.entries()) {
    for (const run of nsState.runs.values()) {
      const phase = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
      if (phase !== 'Running') continue
      cluster += 1
      const repository = resolveRunRepository(run)
      if (repository) {
        const key = normalizeRepositoryKey(repository)
        perRepository.set(key, (perRepository.get(key) ?? 0) + 1)
      }
      if (ns !== namespace) continue
      total += 1
      const agentName = asString(readNested(run, ['spec', 'agentRef', 'name'])) ?? 'unknown'
      perAgent.set(agentName, (perAgent.get(agentName) ?? 0) + 1)
    }
  }
  return { total, perAgent, perRepository, cluster }
}

export const resolveRepoConcurrencyLimit = (repository: string, config: RepoConcurrencyConfig) => {
  if (!config.enabled) return null
  if (!repository.trim()) return null
  const key = normalizeRepositoryKey(repository)
  const override = config.overrides.get(key)
  const limit = override ?? config.defaultLimit
  if (!limit || limit <= 0) return null
  return limit
}

export const buildQueueCounts = (input: {
  namespace: string
  runName: string
  normalizedRepo: string
  namespaceRuns: Record<string, unknown>[]
  controllerSnapshot: ControllerState | null
}) => {
  const { namespace, runName, normalizedRepo, namespaceRuns, controllerSnapshot } = input
  let queuedNamespace = 0
  let queuedCluster = 0
  let queuedRepo = 0

  const visitRun = (run: Record<string, unknown>, runNamespace: string) => {
    const itemName = asString(readNested(run, ['metadata', 'name'])) ?? ''
    if (!itemName || itemName === runName) return
    if (!isQueuedRun(run)) return
    queuedCluster += 1
    if (runNamespace === namespace) {
      queuedNamespace += 1
    }
    if (normalizedRepo) {
      const runRepo = resolveRunRepository(run)
      if (runRepo && normalizeRepository(runRepo) === normalizedRepo) {
        queuedRepo += 1
      }
    }
  }

  if (controllerSnapshot) {
    for (const [runNamespace, nsState] of controllerSnapshot.namespaces.entries()) {
      for (const run of nsState.runs.values()) {
        visitRun(run, runNamespace)
      }
    }
  } else {
    for (const run of namespaceRuns) {
      visitRun(run, namespace)
    }
  }

  return { queuedNamespace, queuedCluster, queuedRepo }
}
