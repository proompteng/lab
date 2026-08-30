import type { KubernetesClient } from '../kube-types'
import type { PolicyChecks } from '../primitives-policy'
import type { EnvSource } from '../runtime-env'

import type { AgentRunsApiStore } from './agent-run-store'

export type AgentRunRuntimeConfigOptions = {
  readonly env?: EnvSource
  readonly now?: () => number
}

export type AgentRunsApiDependencies = {
  storeFactory: () => AgentRunsApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  runtimeConfig?: AgentRunRuntimeConfigOptions
  requireLeaderForMutation?: () => Response | null
  recordAgentQueueDepth?: (
    depth: number,
    labels: { scope: 'namespace' | 'cluster' | 'repo'; namespace?: string; repository?: string },
  ) => void
  resolveAuditContextFromRequest?: (
    request: Request,
    defaults: { deliveryId: string; namespace: string; repository?: string; source: string },
  ) => Record<string, unknown>
  resolveRepositoryFromParameters?: (params: Record<string, string> | undefined) => string | undefined
  validatePolicies?: (namespace: string, checks: PolicyChecks, kube: KubernetesClient) => Promise<void>
  idGenerator?: () => string
}
