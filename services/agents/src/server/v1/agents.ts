import { randomUUID } from 'node:crypto'

import { Context, Data, Effect, Layer } from 'effect'

import { resolveAuditContextFromRequest as defaultResolveAuditContextFromRequest } from '../audit-logging'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace } from '../primitives'
import {
  extractRequiredSecrets,
  type PolicyChecks,
  validatePolicies as defaultValidatePolicies,
} from '../primitives-policy'

import { buildDeliveryIdLabels } from './delivery-labels'

export type AgentsApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
}

export type AgentsApiDependencies = {
  storeFactory: () => AgentsApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  requireLeaderForMutation?: () => Response | null
  resolveAuditContextFromRequest?: (
    request: Request,
    defaults: { deliveryId: string; namespace: string; repository: string | null; source: string },
  ) => Record<string, unknown>
  validatePolicies?: (namespace: string, checks: PolicyChecks, kube: KubernetesClient) => Promise<void>
  idGenerator?: () => string
}

type AgentPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
  policy?: Record<string, unknown>
}

type AgentSubmitSuccess = {
  status: number
  body: Record<string, unknown>
}

type AgentSubmitStorageOperation = 'open-store' | 'store-ready' | 'create-audit-event'
type AgentSubmitKubeOperation = 'create-client' | 'apply-agent'

export class AgentSubmitInvalidPayloadError extends Data.TaggedError('AgentSubmitInvalidPayloadError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AgentSubmitStorageError extends Data.TaggedError('AgentSubmitStorageError')<{
  readonly operation: AgentSubmitStorageOperation
  readonly cause: unknown
}> {}

export class AgentSubmitKubeError extends Data.TaggedError('AgentSubmitKubeError')<{
  readonly operation: AgentSubmitKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class AgentSubmitPolicyDeniedError extends Data.TaggedError('AgentSubmitPolicyDeniedError')<{
  readonly subject: { kind: string; name: string; namespace?: string }
  readonly cause: unknown
}> {}

export class AgentSubmitForbiddenError extends Data.TaggedError('AgentSubmitForbiddenError')<{
  readonly message: string
}> {}

type AgentSubmitError =
  | AgentSubmitInvalidPayloadError
  | AgentSubmitStorageError
  | AgentSubmitKubeError
  | AgentSubmitPolicyDeniedError
  | AgentSubmitForbiddenError

type AgentStoreServiceDefinition = {
  readonly open: Effect.Effect<AgentsApiStore, AgentSubmitStorageError>
  readonly ready: (store: AgentsApiStore) => Effect.Effect<void, AgentSubmitStorageError>
  readonly createAuditEvent: (
    store: AgentsApiStore,
    input: Parameters<AgentsApiStore['createAuditEvent']>[0],
  ) => Effect.Effect<unknown, AgentSubmitStorageError>
  readonly close: (store: AgentsApiStore) => Effect.Effect<void>
}

type AgentKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, AgentSubmitKubeError>
  readonly applyAgent: (
    kube: KubernetesClient,
    resource: Record<string, unknown>,
    namespace: string,
  ) => Effect.Effect<Record<string, unknown>, AgentSubmitKubeError>
}

type AgentPolicyServiceDefinition = {
  readonly validate: (
    namespace: string,
    checks: PolicyChecks,
    kube: KubernetesClient,
  ) => Effect.Effect<void, AgentSubmitPolicyDeniedError>
}

type AgentAuditContextServiceDefinition = {
  readonly resolve: NonNullable<AgentsApiDependencies['resolveAuditContextFromRequest']>
}

type AgentIdGeneratorServiceDefinition = {
  readonly next: Effect.Effect<string>
}

export class AgentStoreService extends Context.Tag('agents/AgentStoreService')<
  AgentStoreService,
  AgentStoreServiceDefinition
>() {}

export class AgentKubernetesService extends Context.Tag('agents/AgentKubernetesService')<
  AgentKubernetesService,
  AgentKubernetesServiceDefinition
>() {}

export class AgentPolicyService extends Context.Tag('agents/AgentPolicyService')<
  AgentPolicyService,
  AgentPolicyServiceDefinition
>() {}

export class AgentAuditContextService extends Context.Tag('agents/AgentAuditContextService')<
  AgentAuditContextService,
  AgentAuditContextServiceDefinition
>() {}

export class AgentIdGeneratorService extends Context.Tag('agents/AgentIdGeneratorService')<
  AgentIdGeneratorService,
  AgentIdGeneratorServiceDefinition
>() {}

type AgentSubmitServices =
  | AgentStoreService
  | AgentKubernetesService
  | AgentPolicyService
  | AgentAuditContextService
  | AgentIdGeneratorService

const getKubeClient = (deps: Pick<AgentsApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeAgentSubmitError = (error: unknown) => {
  if (error instanceof AgentSubmitInvalidPayloadError) return error.message
  if (error instanceof AgentSubmitForbiddenError) return error.message
  if (error instanceof AgentSubmitPolicyDeniedError) {
    return `policy denied for ${error.subject.kind} ${error.subject.namespace}/${error.subject.name}: ${toErrorMessage(
      error.cause,
    )}`
  }
  if (error instanceof AgentSubmitStorageError) {
    return `agent storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof AgentSubmitKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

const agentSubmitStatus = (error: unknown) => {
  if (error instanceof AgentSubmitInvalidPayloadError) return 400
  if (error instanceof AgentSubmitForbiddenError || error instanceof AgentSubmitPolicyDeniedError) return 403
  if (error instanceof AgentSubmitKubeError) return 502
  if (error instanceof AgentSubmitStorageError) return 503
  return 500
}

const parseAgentPayload = (payload: Record<string, unknown>): AgentPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  const policy = asRecord(payload.policy) ?? undefined
  return { name, namespace, spec, policy }
}

const storeEffect = <A>(
  operation: AgentSubmitStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, AgentSubmitStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentSubmitStorageError({ operation, cause }),
  })

const kubeEffect = <A>(
  operation: AgentSubmitKubeOperation,
  resource: string,
  namespace: string,
  run: () => Promise<A>,
): Effect.Effect<A, AgentSubmitKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentSubmitKubeError({ operation, resource, namespace, cause }),
  })

const closeStoreEffect = (store: AgentsApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

const makeAgentStoreService = (storeFactory: AgentsApiDependencies['storeFactory']): AgentStoreServiceDefinition => ({
  open: Effect.try({
    try: () => storeFactory(),
    catch: (cause) => new AgentSubmitStorageError({ operation: 'open-store', cause }),
  }),
  ready: (store) => storeEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
  createAuditEvent: (store, input) => storeEffect('create-audit-event', () => store.createAuditEvent(input)),
  close: closeStoreEffect,
})

export const makeAgentSubmitLayer = (deps: AgentsApiDependencies) =>
  Layer.mergeAll(
    Layer.succeed(AgentStoreService, makeAgentStoreService(deps.storeFactory)),
    Layer.succeed(AgentKubernetesService, {
      client: (namespace) =>
        Effect.try({
          try: () => getKubeClient(deps),
          catch: (cause) =>
            new AgentSubmitKubeError({
              operation: 'create-client',
              resource: 'kubernetes-client',
              namespace,
              cause,
            }),
        }),
      applyAgent: (kube, resource, namespace) =>
        kubeEffect('apply-agent', RESOURCE_MAP.Agent, namespace, () => kube.apply(resource)),
    }),
    Layer.succeed(AgentPolicyService, {
      validate: (namespace, checks, kube) =>
        Effect.tryPromise({
          try: () => (deps.validatePolicies ?? defaultValidatePolicies)(namespace, checks, kube),
          catch: (cause) =>
            new AgentSubmitPolicyDeniedError({
              subject: checks.subject ?? { kind: 'Agent', name: 'unknown', namespace },
              cause,
            }),
        }),
    }),
    Layer.succeed(AgentAuditContextService, {
      resolve: deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest,
    }),
    Layer.succeed(AgentIdGeneratorService, {
      next: Effect.sync(deps.idGenerator ?? randomUUID),
    }),
  )

const createAgentResource = (parsed: AgentPayload, deliveryId: string): Record<string, unknown> => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'Agent',
  metadata: {
    name: parsed.name,
    namespace: parsed.namespace,
    labels: buildDeliveryIdLabels(deliveryId),
  },
  spec: parsed.spec,
})

export const submitAgentEffect = (
  request: Request,
  deps: AgentsApiDependencies,
): Effect.Effect<AgentSubmitSuccess, AgentSubmitError> =>
  submitAgentWithServicesEffect(request).pipe(Effect.provide(makeAgentSubmitLayer(deps)))

export const submitAgentWithServicesEffect = (
  request: Request,
): Effect.Effect<AgentSubmitSuccess, AgentSubmitError, AgentSubmitServices> =>
  Effect.gen(function* () {
    const stores = yield* AgentStoreService
    const kubernetes = yield* AgentKubernetesService
    const policies = yield* AgentPolicyService
    const auditContexts = yield* AgentAuditContextService
    const ids = yield* AgentIdGeneratorService
    const deliveryId = yield* Effect.try({
      try: () => requireIdempotencyKey(request),
      catch: (cause) => new AgentSubmitInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new AgentSubmitInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })
    const parsed = yield* Effect.try({
      try: () => parseAgentPayload(payload),
      catch: (cause) => new AgentSubmitInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })

    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          const auditContext = auditContexts.resolve(request, {
            deliveryId,
            namespace: parsed.namespace,
            repository: null,
            source: 'v1.agents',
          })
          const requiredSecrets = extractRequiredSecrets(parsed.spec)
          const policy = parsed.policy ?? {}
          const policyChecks: PolicyChecks = {
            budgetRef: asString(policy.budgetRef) ?? undefined,
            secretBindingRef: asString(policy.secretBindingRef) ?? undefined,
            requiredSecrets,
            subject: { kind: 'Agent', name: parsed.name, namespace: parsed.namespace },
          }

          if (requiredSecrets.length > 0 && !policyChecks.secretBindingRef) {
            return yield* Effect.fail(
              new AgentSubmitForbiddenError({ message: 'secretBindingRef is required when allowedSecrets are set' }),
            )
          }

          yield* stores.ready(activeStore)
          const kube = yield* kubernetes.client(parsed.namespace)
          const policyDecision = yield* policies.validate(parsed.namespace, policyChecks, kube).pipe(Effect.either)

          if (policyDecision._tag === 'Left') {
            const auditEventId = yield* ids.next
            yield* stores
              .createAuditEvent(activeStore, {
                entityType: 'PolicyDecision',
                entityId: auditEventId,
                eventType: 'policy.denied',
                context: auditContext,
                details: {
                  subject: policyChecks.subject,
                  checks: policyChecks,
                  reason: describeAgentSubmitError(policyDecision.left),
                },
              })
              .pipe(Effect.catchAll(() => Effect.void))
            return yield* Effect.fail(policyDecision.left)
          }

          const auditEventId = yield* ids.next
          yield* stores.createAuditEvent(activeStore, {
            entityType: 'PolicyDecision',
            entityId: auditEventId,
            eventType: 'policy.allowed',
            context: auditContext,
            details: { subject: policyChecks.subject, checks: policyChecks },
          })

          const applied = yield* kubernetes.applyAgent(kube, createAgentResource(parsed, deliveryId), parsed.namespace)
          const metadata = (applied.metadata ?? {}) as Record<string, unknown>
          const uid = asString(metadata.uid)

          if (uid) {
            yield* stores.createAuditEvent(activeStore, {
              entityType: 'Agent',
              entityId: uid,
              eventType: 'agent.created',
              context: auditContext,
              details: { name: parsed.name, agentUid: uid },
            })
          }

          return { status: 201, body: { ok: true, agent: applied } }
        }),
      stores.close,
    )
  })

export const postAgentsHandler = async (request: Request, deps: AgentsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.()
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitAgentEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Left') {
    return errorResponse(describeAgentSubmitError(result.left), agentSubmitStatus(result.left))
  }
  return okResponse(result.right.body, result.right.status)
}
