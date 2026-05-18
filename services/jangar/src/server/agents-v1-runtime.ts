import { configureAgentsV1Runtime, type AgentsV1RuntimeDependencies } from '@proompteng/agents/server/v1/runtime'
import {
  resolveAuditContextFromRequest,
  resolveRepositoryFromParameters as resolveRepositoryFromParameterMap,
} from '~/server/audit-logging'
import { requireLeaderForMutationHttp } from '~/server/leader-election'
import { recordAgentQueueDepth } from '~/server/metrics'
import { createKubernetesClient } from '~/server/primitives-kube'
import { validatePolicies } from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'

const createJangarPrimitivesStore = () => createPrimitivesStore()

export const JANGAR_AGENTS_V1_RUNTIME_DEPENDENCIES = {
  agentRuns: {
    storeFactory: createJangarPrimitivesStore,
    kubeClientFactory: createKubernetesClient,
    requireLeaderForMutation: requireLeaderForMutationHttp,
    recordAgentQueueDepth,
    resolveAuditContextFromRequest,
    resolveRepositoryFromParameters: (params) => resolveRepositoryFromParameterMap(params) ?? undefined,
    validatePolicies,
  },
  runRead: {
    storeFactory: createJangarPrimitivesStore,
    kubeClientFactory: createKubernetesClient,
  },
} satisfies AgentsV1RuntimeDependencies

configureAgentsV1Runtime(JANGAR_AGENTS_V1_RUNTIME_DEPENDENCIES)
