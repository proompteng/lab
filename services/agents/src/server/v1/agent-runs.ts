import { Effect } from 'effect'

import { errorResponse, okResponse } from '../http'
import { type KubernetesClient } from '../kube-types'
import { asString } from '../primitives'
import type { PolicyChecks } from '../primitives-policy'

import {
  AgentRunStorageError,
  agentRunSubmitDetails,
  agentRunSubmitStatus,
  describeAgentRunSubmitError,
  submitAgentRunEffect,
  type AgentRunRuntimeConfigOptions,
} from './agent-run-submit'

export {
  AgentRunAdmissionRejectedError,
  AgentRunAuditContextService,
  AgentRunConflictError,
  AgentRunForbiddenError,
  AgentRunInvalidPayloadError,
  AgentRunKubeError,
  AgentRunKubernetesService,
  AgentRunNotFoundError,
  AgentRunPolicyDeniedError,
  AgentRunPolicyService,
  AgentRunQueueDepthService,
  AgentRunRepositoryService,
  AgentRunRuntimeConfigService,
  AgentRunStorageError,
  AgentRunStoreService,
  createAgentRunResource,
  describeAgentRunSubmitError,
  makeAgentRunRuntimeConfigService,
  makeAgentRunSubmitLayer,
  submitAgentRun,
  submitAgentRunEffect,
  submitAgentRunWithServicesEffect,
} from './agent-run-submit'
export type { AgentRunRuntimeConfigOptions, AgentRunSubmissionConfig, AgentRunSubmitError } from './agent-run-submit'

export type AgentRunIdempotencyRecord = {
  namespace: string
  agentName: string
  idempotencyKey: string
  agentRunName: string | null
  agentRunUid: string | null
  createdAt: Date | string
}

export type AgentRunIdempotencyReservation = {
  record: AgentRunIdempotencyRecord
  created: boolean
}

export type AgentRunRecord = {
  id: string
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: unknown
  updatedAt?: unknown
}

export type AgentRunsApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  listAgentRuns: (input?: {
    agentName?: string | null
    statuses?: string[] | null
    limit?: number | null
  }) => Promise<unknown[]>
  getAgentRunByDeliveryId: (deliveryId: string) => Promise<AgentRunRecord | null>
  getAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyRecord | null>
  reserveAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyReservation>
  deleteAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<unknown>
  assignAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
    agentRunName: string
    agentRunUid: string | null
  }) => Promise<unknown>
  createAgentRun: (input: {
    agentName: string
    deliveryId: string
    provider: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<AgentRunRecord>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
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
}

const parseListLimit = (value: string | null) => {
  if (!value) return 50
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 500)
}

const parseStatusFilter = (value: string | null) => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

type AgentRunListInput = {
  agentName?: string | null
  statuses?: string[] | null
  limit?: number | null
}

const acquireAgentRunsStoreEffect = (deps: Pick<AgentRunsApiDependencies, 'storeFactory'>) =>
  Effect.try({
    try: () => deps.storeFactory(),
    catch: (cause) => new AgentRunStorageError({ operation: 'open-store', cause }),
  })

const waitForAgentRunsStoreReadyEffect = (store: AgentRunsApiStore) =>
  Effect.tryPromise({
    try: () => store.ready,
    catch: (cause) => new AgentRunStorageError({ operation: 'store-ready', cause }),
  })

const closeAgentRunsStoreEffect = (store: AgentRunsApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: (cause) => new AgentRunStorageError({ operation: 'close-store', cause }),
  }).pipe(Effect.catchAll(() => Effect.void))

const listAgentRunsWithStoreEffect = (store: AgentRunsApiStore, input: AgentRunListInput) =>
  waitForAgentRunsStoreReadyEffect(store).pipe(
    Effect.zipRight(
      Effect.tryPromise({
        try: () => store.listAgentRuns(input),
        catch: (cause) => new AgentRunStorageError({ operation: 'list-runs', cause }),
      }),
    ),
  )

const listAgentRunsEffect = (deps: Pick<AgentRunsApiDependencies, 'storeFactory'>, input: AgentRunListInput) =>
  Effect.acquireUseRelease(
    acquireAgentRunsStoreEffect(deps),
    (store) => listAgentRunsWithStoreEffect(store, input),
    closeAgentRunsStoreEffect,
  )

export const getAgentRunsHandler = async (request: Request, deps: Pick<AgentRunsApiDependencies, 'storeFactory'>) => {
  const url = new URL(request.url)
  const agentName = asString(url.searchParams.get('agentId')) ?? asString(url.searchParams.get('agentName'))
  const statuses = parseStatusFilter(url.searchParams.get('status'))
  const limit = parseListLimit(url.searchParams.get('limit'))
  if (!agentName && statuses.length === 0) return errorResponse('agentId or status is required', 400)

  const result = await Effect.runPromise(listAgentRunsEffect(deps, { agentName, statuses, limit }).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse({ ok: true, runs: result.right })
  return errorResponse(describeAgentRunSubmitError(result.left), agentRunSubmitStatus(result.left))
}

export const postAgentRunsHandler = async (request: Request, deps: AgentRunsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitAgentRunEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Right') {
    return okResponse(result.right.body, result.right.status)
  }
  return errorResponse(
    describeAgentRunSubmitError(result.left),
    agentRunSubmitStatus(result.left),
    agentRunSubmitDetails(result.left),
  )
}
