import { randomUUID } from 'node:crypto'

import { Context, Data, Effect, Layer } from 'effect'

import { resolveAuditContextFromRequest as defaultResolveAuditContextFromRequest } from '../audit-logging'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace } from '../primitives'
import {
  extractApprovalPolicies,
  type PolicyChecks,
  validatePolicies as defaultValidatePolicies,
} from '../primitives-policy'

import { buildDeliveryIdLabels } from './delivery-labels'

export type OrchestrationsApiStore = {
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

export type OrchestrationsApiDependencies = {
  storeFactory: () => OrchestrationsApiStore
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

type OrchestrationPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
  policy?: Record<string, unknown>
}

type OrchestrationSubmitSuccess = {
  status: number
  body: Record<string, unknown>
}

type OrchestrationResourceSubmitStorageOperation = 'open-store' | 'store-ready' | 'create-audit-event'
type OrchestrationResourceSubmitKubeOperation = 'create-client' | 'apply-orchestration'

export class OrchestrationResourceInvalidPayloadError extends Data.TaggedError(
  'OrchestrationResourceInvalidPayloadError',
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class OrchestrationResourceStorageError extends Data.TaggedError('OrchestrationResourceStorageError')<{
  readonly operation: OrchestrationResourceSubmitStorageOperation
  readonly cause: unknown
}> {}

export class OrchestrationResourceKubeError extends Data.TaggedError('OrchestrationResourceKubeError')<{
  readonly operation: OrchestrationResourceSubmitKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class OrchestrationResourcePolicyDeniedError extends Data.TaggedError('OrchestrationResourcePolicyDeniedError')<{
  readonly subject: { kind: string; name: string; namespace?: string }
  readonly cause: unknown
}> {}

type OrchestrationResourceSubmitError =
  | OrchestrationResourceInvalidPayloadError
  | OrchestrationResourceStorageError
  | OrchestrationResourceKubeError
  | OrchestrationResourcePolicyDeniedError

type OrchestrationStoreServiceDefinition = {
  readonly open: Effect.Effect<OrchestrationsApiStore, OrchestrationResourceStorageError>
  readonly ready: (store: OrchestrationsApiStore) => Effect.Effect<void, OrchestrationResourceStorageError>
  readonly createAuditEvent: (
    store: OrchestrationsApiStore,
    input: Parameters<OrchestrationsApiStore['createAuditEvent']>[0],
  ) => Effect.Effect<unknown, OrchestrationResourceStorageError>
  readonly close: (store: OrchestrationsApiStore) => Effect.Effect<void>
}

type OrchestrationKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, OrchestrationResourceKubeError>
  readonly applyOrchestration: (
    kube: KubernetesClient,
    resource: Record<string, unknown>,
    namespace: string,
  ) => Effect.Effect<Record<string, unknown>, OrchestrationResourceKubeError>
}

type OrchestrationPolicyServiceDefinition = {
  readonly validate: (
    namespace: string,
    checks: PolicyChecks,
    kube: KubernetesClient,
  ) => Effect.Effect<void, OrchestrationResourcePolicyDeniedError>
}

type OrchestrationAuditContextServiceDefinition = {
  readonly resolve: NonNullable<OrchestrationsApiDependencies['resolveAuditContextFromRequest']>
}

type OrchestrationIdGeneratorServiceDefinition = {
  readonly next: Effect.Effect<string>
}

export class OrchestrationStoreService extends Context.Tag('agents/OrchestrationStoreService')<
  OrchestrationStoreService,
  OrchestrationStoreServiceDefinition
>() {}

export class OrchestrationKubernetesService extends Context.Tag('agents/OrchestrationKubernetesService')<
  OrchestrationKubernetesService,
  OrchestrationKubernetesServiceDefinition
>() {}

export class OrchestrationPolicyService extends Context.Tag('agents/OrchestrationPolicyService')<
  OrchestrationPolicyService,
  OrchestrationPolicyServiceDefinition
>() {}

export class OrchestrationAuditContextService extends Context.Tag('agents/OrchestrationAuditContextService')<
  OrchestrationAuditContextService,
  OrchestrationAuditContextServiceDefinition
>() {}

export class OrchestrationIdGeneratorService extends Context.Tag('agents/OrchestrationIdGeneratorService')<
  OrchestrationIdGeneratorService,
  OrchestrationIdGeneratorServiceDefinition
>() {}

type OrchestrationResourceSubmitServices =
  | OrchestrationStoreService
  | OrchestrationKubernetesService
  | OrchestrationPolicyService
  | OrchestrationAuditContextService
  | OrchestrationIdGeneratorService

const getKubeClient = (deps: Pick<OrchestrationsApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeOrchestrationResourceSubmitError = (error: unknown) => {
  if (error instanceof OrchestrationResourceInvalidPayloadError) return error.message
  if (error instanceof OrchestrationResourcePolicyDeniedError) {
    return `policy denied for ${error.subject.kind} ${error.subject.namespace}/${error.subject.name}: ${toErrorMessage(
      error.cause,
    )}`
  }
  if (error instanceof OrchestrationResourceStorageError) {
    return `orchestration storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof OrchestrationResourceKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

const orchestrationResourceSubmitStatus = (error: unknown) => {
  if (error instanceof OrchestrationResourceInvalidPayloadError) return 400
  if (error instanceof OrchestrationResourcePolicyDeniedError) return 403
  if (error instanceof OrchestrationResourceKubeError) return 502
  if (error instanceof OrchestrationResourceStorageError) return 503
  return 500
}

const parseOrchestrationPayload = (payload: Record<string, unknown>): OrchestrationPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  const policy = asRecord(payload.policy) ?? undefined
  return { name, namespace, spec, policy }
}

const storeEffect = <A>(
  operation: OrchestrationResourceSubmitStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, OrchestrationResourceStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationResourceStorageError({ operation, cause }),
  })

const kubeEffect = <A>(
  operation: OrchestrationResourceSubmitKubeOperation,
  resource: string,
  namespace: string,
  run: () => Promise<A>,
): Effect.Effect<A, OrchestrationResourceKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationResourceKubeError({ operation, resource, namespace, cause }),
  })

const closeStoreEffect = (store: OrchestrationsApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

const makeOrchestrationStoreService = (
  storeFactory: OrchestrationsApiDependencies['storeFactory'],
): OrchestrationStoreServiceDefinition => ({
  open: Effect.try({
    try: () => storeFactory(),
    catch: (cause) => new OrchestrationResourceStorageError({ operation: 'open-store', cause }),
  }),
  ready: (store) => storeEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
  createAuditEvent: (store, input) => storeEffect('create-audit-event', () => store.createAuditEvent(input)),
  close: closeStoreEffect,
})

export const makeOrchestrationResourceSubmitLayer = (deps: OrchestrationsApiDependencies) =>
  Layer.mergeAll(
    Layer.succeed(OrchestrationStoreService, makeOrchestrationStoreService(deps.storeFactory)),
    Layer.succeed(OrchestrationKubernetesService, {
      client: (namespace) =>
        Effect.try({
          try: () => getKubeClient(deps),
          catch: (cause) =>
            new OrchestrationResourceKubeError({
              operation: 'create-client',
              resource: 'kubernetes-client',
              namespace,
              cause,
            }),
        }),
      applyOrchestration: (kube, resource, namespace) =>
        kubeEffect('apply-orchestration', RESOURCE_MAP.Orchestration, namespace, () => kube.apply(resource)),
    }),
    Layer.succeed(OrchestrationPolicyService, {
      validate: (namespace, checks, kube) =>
        Effect.tryPromise({
          try: () => (deps.validatePolicies ?? defaultValidatePolicies)(namespace, checks, kube),
          catch: (cause) =>
            new OrchestrationResourcePolicyDeniedError({
              subject: checks.subject ?? { kind: 'Orchestration', name: 'unknown', namespace },
              cause,
            }),
        }),
    }),
    Layer.succeed(OrchestrationAuditContextService, {
      resolve: deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest,
    }),
    Layer.succeed(OrchestrationIdGeneratorService, {
      next: Effect.sync(deps.idGenerator ?? randomUUID),
    }),
  )

const createOrchestrationResource = (parsed: OrchestrationPayload, deliveryId: string): Record<string, unknown> => ({
  apiVersion: 'orchestration.proompteng.ai/v1alpha1',
  kind: 'Orchestration',
  metadata: {
    name: parsed.name,
    namespace: parsed.namespace,
    labels: buildDeliveryIdLabels(deliveryId),
  },
  spec: parsed.spec,
})

export const submitOrchestrationResourceEffect = (
  request: Request,
  deps: OrchestrationsApiDependencies,
): Effect.Effect<OrchestrationSubmitSuccess, OrchestrationResourceSubmitError> =>
  submitOrchestrationResourceWithServicesEffect(request).pipe(
    Effect.provide(makeOrchestrationResourceSubmitLayer(deps)),
  )

export const submitOrchestrationResourceWithServicesEffect = (
  request: Request,
): Effect.Effect<OrchestrationSubmitSuccess, OrchestrationResourceSubmitError, OrchestrationResourceSubmitServices> =>
  Effect.gen(function* () {
    const stores = yield* OrchestrationStoreService
    const kubernetes = yield* OrchestrationKubernetesService
    const policies = yield* OrchestrationPolicyService
    const auditContexts = yield* OrchestrationAuditContextService
    const ids = yield* OrchestrationIdGeneratorService
    const deliveryId = yield* Effect.try({
      try: () => requireIdempotencyKey(request),
      catch: (cause) => new OrchestrationResourceInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) => new OrchestrationResourceInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })
    const parsed = yield* Effect.try({
      try: () => parseOrchestrationPayload(payload),
      catch: (cause) => new OrchestrationResourceInvalidPayloadError({ message: toErrorMessage(cause), cause }),
    })

    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          const auditContext = auditContexts.resolve(request, {
            deliveryId,
            namespace: parsed.namespace,
            repository: null,
            source: 'v1.orchestrations',
          })
          const steps = Array.isArray(parsed.spec.steps) ? (parsed.spec.steps as Record<string, unknown>[]) : []
          const approvalPolicies = extractApprovalPolicies(steps)
          const policy = parsed.policy ?? {}
          const policyChecks: PolicyChecks = {
            approvalPolicies,
            budgetRef: asString(policy.budgetRef) ?? undefined,
            subject: { kind: 'Orchestration', name: parsed.name, namespace: parsed.namespace },
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
                  reason: describeOrchestrationResourceSubmitError(policyDecision.left),
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

          const applied = yield* kubernetes.applyOrchestration(
            kube,
            createOrchestrationResource(parsed, deliveryId),
            parsed.namespace,
          )
          const metadata = (applied.metadata ?? {}) as Record<string, unknown>
          const uid = asString(metadata.uid)

          if (uid) {
            yield* stores.createAuditEvent(activeStore, {
              entityType: 'Orchestration',
              entityId: uid,
              eventType: 'orchestration.created',
              context: auditContext,
              details: { name: parsed.name, orchestrationUid: uid },
            })
          }

          return { status: 201, body: { ok: true, orchestration: applied } }
        }),
      stores.close,
    )
  })

export const postOrchestrationsHandler = async (request: Request, deps: OrchestrationsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.()
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitOrchestrationResourceEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Left') {
    return errorResponse(
      describeOrchestrationResourceSubmitError(result.left),
      orchestrationResourceSubmitStatus(result.left),
    )
  }
  return okResponse(result.right.body, result.right.status)
}
