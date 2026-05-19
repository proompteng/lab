import { randomUUID } from 'node:crypto'

import { Data, Effect } from 'effect'

import { resolveRepositoryFromParameters as defaultResolveRepositoryFromParameters } from '../audit-logging'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, readNested } from '../primitives'
import {
  extractApprovalPolicies,
  type PolicyChecks,
  validatePolicies as defaultValidatePolicies,
} from '../primitives-policy'
import type { OrchestrationRunRecord } from '../primitives-store'

import { buildDeliveryIdLabels } from './delivery-labels'

export type OrchestrationRunSubmitInput = {
  deliveryId: string
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
}

export type OrchestrationRunSubmitStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getOrchestrationRunByDeliveryId: (deliveryId: string) => Promise<OrchestrationRunRecord | null>
  createOrchestrationRun: (input: {
    orchestrationName: string
    deliveryId: string
    provider: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<OrchestrationRunRecord>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
}

export type SubmitOrchestrationRunDeps = {
  storeFactory: () => OrchestrationRunSubmitStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  resolveRepositoryFromParameters?: (params: Record<string, string> | undefined) => string | null | undefined
  validatePolicies?: (namespace: string, checks: PolicyChecks, kube: KubernetesClient) => Promise<void>
}

type OrchestrationRunSubmitResult = {
  orchestrationRun: OrchestrationRunRecord
  resource: Record<string, unknown> | null
  idempotent: boolean
}

type OrchestrationSubmitStorageOperation =
  | 'open-store'
  | 'store-ready'
  | 'read-idempotency-record'
  | 'create-run-record'
  | 'create-audit-event'

type OrchestrationSubmitKubeOperation = 'get-existing-run' | 'get-orchestration' | 'apply-orchestration-run'

export class OrchestrationSubmitStorageError extends Data.TaggedError('OrchestrationSubmitStorageError')<{
  readonly operation: OrchestrationSubmitStorageOperation
  readonly cause: unknown
}> {}

export class OrchestrationSubmitKubeError extends Data.TaggedError('OrchestrationSubmitKubeError')<{
  readonly operation: OrchestrationSubmitKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class OrchestrationSubmitNotFoundError extends Data.TaggedError('OrchestrationSubmitNotFoundError')<{
  readonly orchestrationName: string
  readonly namespace: string
}> {}

export class OrchestrationSubmitPolicyDeniedError extends Data.TaggedError('OrchestrationSubmitPolicyDeniedError')<{
  readonly subject: { kind: string; name: string; namespace?: string }
  readonly cause: unknown
}> {}

export type OrchestrationSubmitError =
  | OrchestrationSubmitStorageError
  | OrchestrationSubmitKubeError
  | OrchestrationSubmitNotFoundError
  | OrchestrationSubmitPolicyDeniedError

const getKubeClient = (deps: Pick<SubmitOrchestrationRunDeps, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeOrchestrationSubmitError = (error: unknown) => {
  if (error instanceof OrchestrationSubmitNotFoundError) {
    return `orchestration ${error.orchestrationName} not found in namespace ${error.namespace}`
  }
  if (error instanceof OrchestrationSubmitPolicyDeniedError) {
    return `policy denied for ${error.subject.kind} ${error.subject.namespace}/${error.subject.name}: ${toErrorMessage(
      error.cause,
    )}`
  }
  if (error instanceof OrchestrationSubmitStorageError) {
    return `orchestration run storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof OrchestrationSubmitKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

const storeEffect = <A>(
  operation: OrchestrationSubmitStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, OrchestrationSubmitStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationSubmitStorageError({ operation, cause }),
  })

const kubeEffect = <A>(
  operation: OrchestrationSubmitKubeOperation,
  resource: string,
  namespace: string,
  run: () => Promise<A>,
): Effect.Effect<A, OrchestrationSubmitKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationSubmitKubeError({ operation, resource, namespace, cause }),
  })

const closeStoreEffect = (store: OrchestrationRunSubmitStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

const normalizeStringMap = (value: Record<string, unknown> | null): Record<string, string> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return output
}

export const submitOrchestrationRun = async (
  input: OrchestrationRunSubmitInput,
  deps: SubmitOrchestrationRunDeps,
): Promise<OrchestrationRunSubmitResult> => {
  const result = await Effect.runPromise(submitOrchestrationRunEffect(input, deps).pipe(Effect.either))
  if (result._tag === 'Left') throw result.left
  return result.right
}

export const submitOrchestrationRunEffect = (
  input: OrchestrationRunSubmitInput,
  deps: SubmitOrchestrationRunDeps,
): Effect.Effect<OrchestrationRunSubmitResult, OrchestrationSubmitError> =>
  Effect.gen(function* () {
    const store = yield* Effect.try({
      try: () => deps.storeFactory(),
      catch: (cause) => new OrchestrationSubmitStorageError({ operation: 'open-store', cause }),
    })
    return yield* Effect.gen(function* () {
      yield* storeEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined))

      const repository = (deps.resolveRepositoryFromParameters ?? defaultResolveRepositoryFromParameters)(
        input.parameters,
      )
      const baseContext = {
        source: 'v1.orchestration-runs',
        correlationId: input.deliveryId,
        deliveryId: input.deliveryId,
        namespace: input.namespace,
        repository,
      }
      const existing = yield* storeEffect('read-idempotency-record', () =>
        store.getOrchestrationRunByDeliveryId(input.deliveryId),
      )
      if (existing) {
        const resourceNamespace =
          asString(readNested(asRecord(existing.payload) ?? {}, ['resource', 'metadata', 'namespace'])) ??
          asString(readNested(asRecord(existing.payload) ?? {}, ['request', 'namespace'])) ??
          input.namespace
        const kube = getKubeClient(deps)
        const resource = existing.externalRunId
          ? yield* kubeEffect('get-existing-run', RESOURCE_MAP.OrchestrationRun, resourceNamespace, () =>
              kube.get(RESOURCE_MAP.OrchestrationRun, existing.externalRunId!, resourceNamespace),
            )
          : null
        return { orchestrationRun: existing, resource, idempotent: true }
      }

      const kube = getKubeClient(deps)
      const orchestration = yield* kubeEffect('get-orchestration', RESOURCE_MAP.Orchestration, input.namespace, () =>
        kube.get(RESOURCE_MAP.Orchestration, input.orchestrationRef.name, input.namespace),
      )
      if (!orchestration) {
        return yield* Effect.fail(
          new OrchestrationSubmitNotFoundError({
            orchestrationName: input.orchestrationRef.name,
            namespace: input.namespace,
          }),
        )
      }

      const spec = (orchestration.spec ?? {}) as Record<string, unknown>
      const steps = Array.isArray(spec.steps) ? (spec.steps as Record<string, unknown>[]) : []
      const approvalPolicies = extractApprovalPolicies(steps)
      const policy = input.policy ?? {}
      const policyChecks = {
        approvalPolicies,
        budgetRef: asString(policy.budgetRef) ?? undefined,
        subject: { kind: 'Orchestration', name: input.orchestrationRef.name, namespace: input.namespace },
      }

      const validatePolicies = deps.validatePolicies ?? defaultValidatePolicies
      const policyDecision = Effect.tryPromise({
        try: () => validatePolicies(input.namespace, policyChecks, kube),
        catch: (cause) => new OrchestrationSubmitPolicyDeniedError({ subject: policyChecks.subject, cause }),
      })

      yield* policyDecision.pipe(
        Effect.flatMap(() =>
          storeEffect('create-audit-event', () =>
            store.createAuditEvent({
              entityType: 'PolicyDecision',
              entityId: randomUUID(),
              eventType: 'policy.allowed',
              context: baseContext,
              details: { subject: policyChecks.subject, checks: policyChecks },
            }),
          ),
        ),
        Effect.catchAll((error) =>
          storeEffect('create-audit-event', () =>
            store.createAuditEvent({
              entityType: 'PolicyDecision',
              entityId: randomUUID(),
              eventType: 'policy.denied',
              context: baseContext,
              details: {
                subject: policyChecks.subject,
                checks: policyChecks,
                reason: describeOrchestrationSubmitError(error),
              },
            }),
          ).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      )

      const resource: Record<string, unknown> = {
        apiVersion: 'orchestration.proompteng.ai/v1alpha1',
        kind: 'OrchestrationRun',
        metadata: {
          generateName: `${input.orchestrationRef.name}-`,
          namespace: input.namespace,
          labels: buildDeliveryIdLabels(input.deliveryId),
        },
        spec: {
          orchestrationRef: input.orchestrationRef,
          parameters: input.parameters ?? {},
          deliveryId: input.deliveryId,
        },
      }

      const applied = yield* kubeEffect('apply-orchestration-run', RESOURCE_MAP.OrchestrationRun, input.namespace, () =>
        kube.apply(resource),
      )
      const metadata = (applied.metadata ?? {}) as Record<string, unknown>
      const externalRunId = asString(metadata.name)

      const statusPhase = asString(asRecord(applied.status)?.phase) ?? 'Pending'
      const record = yield* storeEffect('create-run-record', () =>
        store.createOrchestrationRun({
          orchestrationName: input.orchestrationRef.name,
          deliveryId: input.deliveryId,
          provider: 'workflow',
          status: statusPhase,
          externalRunId,
          payload: {
            request: {
              orchestrationRef: input.orchestrationRef,
              namespace: input.namespace,
              parameters: normalizeStringMap(input.parameters ?? {}) ?? {},
              policy: input.policy ?? {},
            },
            resource: applied,
            status: asRecord(applied.status) ?? {},
          },
        }),
      )
      yield* storeEffect('create-audit-event', () =>
        store.createAuditEvent({
          entityType: 'OrchestrationRun',
          entityId: record.id,
          eventType: 'orchestration_run.created',
          context: baseContext,
          details: {
            orchestration: input.orchestrationRef.name,
            orchestrationRunId: record.id,
            orchestrationRunName: externalRunId,
            orchestrationRunUid: asString(asRecord(applied.metadata)?.uid),
          },
        }),
      )

      return { orchestrationRun: record, resource: applied, idempotent: false }
    }).pipe(Effect.ensuring(closeStoreEffect(store)))
  })
