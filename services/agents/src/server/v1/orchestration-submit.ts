import { randomUUID } from 'node:crypto'

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

const getKubeClient = (deps: Pick<SubmitOrchestrationRunDeps, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

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
  const store = deps.storeFactory()
  try {
    await store.ready
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
    const existing = await store.getOrchestrationRunByDeliveryId(input.deliveryId)
    if (existing) {
      const resourceNamespace =
        asString(readNested(asRecord(existing.payload) ?? {}, ['resource', 'metadata', 'namespace'])) ??
        asString(readNested(asRecord(existing.payload) ?? {}, ['request', 'namespace'])) ??
        input.namespace
      const kube = getKubeClient(deps)
      const resource = existing.externalRunId
        ? await kube.get(RESOURCE_MAP.OrchestrationRun, existing.externalRunId, resourceNamespace)
        : null
      return { orchestrationRun: existing, resource, idempotent: true }
    }

    const kube = getKubeClient(deps)
    const orchestration = await kube.get(RESOURCE_MAP.Orchestration, input.orchestrationRef.name, input.namespace)
    if (!orchestration) {
      throw new Error(`orchestration ${input.orchestrationRef.name} not found`)
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

    try {
      await (deps.validatePolicies ?? defaultValidatePolicies)(input.namespace, policyChecks, kube)
      await store.createAuditEvent({
        entityType: 'PolicyDecision',
        entityId: randomUUID(),
        eventType: 'policy.allowed',
        context: baseContext,
        details: { subject: policyChecks.subject, checks: policyChecks },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await store.createAuditEvent({
          entityType: 'PolicyDecision',
          entityId: randomUUID(),
          eventType: 'policy.denied',
          context: baseContext,
          details: { subject: policyChecks.subject, checks: policyChecks, reason: message },
        })
      } catch {
        // Audit failures must not mask the policy denial.
      }
      throw error
    }

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

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const externalRunId = asString(metadata.name)

    const statusPhase = asString(asRecord(applied.status)?.phase) ?? 'Pending'
    const record = await store.createOrchestrationRun({
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
    })
    await store.createAuditEvent({
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
    })

    return { orchestrationRun: record, resource: applied, idempotent: false }
  } finally {
    await store.close()
  }
}
