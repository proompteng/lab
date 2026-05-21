import {
  buildExecutionTrust,
  DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
  toExecutionTrustSwarmResources,
  type ExecutionTrustSwarmLister,
} from '@proompteng/agent-contracts'

import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import { normalizeNamespace } from '../primitives'

type EnvSource = Record<string, string | undefined>

export type ExecutionTrustApiDependencies = {
  kubeClient?: KubernetesClient
  now?: () => Date
  env?: EnvSource
}

const parseStringList = (value: string | null | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const uniqueStrings = (values: string[]) => [...new Set(values)]

const parsePositiveInt = (value: string | null | undefined, fallback: number, minimum = 1, maximum = 100) => {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback
  return Math.min(Math.floor(parsed), maximum)
}

const resolveTrackedSwarms = (url: URL, env: EnvSource) => {
  const fromQuery = uniqueStrings(parseStringList(url.searchParams.get('swarms')))
  if (fromQuery.length > 0) return fromQuery
  return uniqueStrings(parseStringList(env.AGENTS_CONTROL_PLANE_EXECUTION_TRUST_SWARMS))
}

const listSwarmsWithKube =
  (kube: KubernetesClient): ExecutionTrustSwarmLister =>
  async (namespace) => {
    const list = await kube.list(RESOURCE_MAP.Swarm, namespace)
    return toExecutionTrustSwarmResources(list, 'kubernetes Swarm list')
  }

export const buildExecutionTrustResponse = async (
  request: Request,
  deps: ExecutionTrustApiDependencies = {},
): Promise<Response> => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const env = deps.env ?? process.env
  const swarms = resolveTrackedSwarms(url, env)
  const summaryLimit = parsePositiveInt(
    url.searchParams.get('summaryLimit') ?? env.AGENTS_CONTROL_PLANE_EXECUTION_TRUST_SUMMARY_LIMIT,
    DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
  )

  try {
    const snapshot = await buildExecutionTrust({
      namespace,
      now: deps.now?.() ?? new Date(),
      swarms,
      listSwarms: listSwarmsWithKube(deps.kubeClient ?? createKubernetesClient()),
      summaryLimit,
    })
    return okResponse(snapshot)
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error), 500)
  }
}
