import { randomUUID } from 'node:crypto'

import { resolveAuditContextFromRequest as defaultResolveAuditContextFromRequest } from '../audit-logging'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
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
}

type OrchestrationPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
  policy?: Record<string, unknown>
}

const getKubeClient = (deps: Pick<OrchestrationsApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const parseOrchestrationPayload = (payload: Record<string, unknown>): OrchestrationPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  const policy = asRecord(payload.policy) ?? undefined
  return { name, namespace, spec, policy }
}

export const postOrchestrationsHandler = async (request: Request, deps: OrchestrationsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.()
  if (leaderResponse) return leaderResponse

  const store = deps.storeFactory()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseOrchestrationPayload(payload)
    const auditContext = (deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest)(request, {
      deliveryId,
      namespace: parsed.namespace,
      repository: null,
      source: 'v1.orchestrations',
    })
    const steps = Array.isArray(parsed.spec.steps) ? (parsed.spec.steps as Record<string, unknown>[]) : []
    const approvalPolicies = extractApprovalPolicies(steps)

    const policy = parsed.policy ?? {}
    const policyChecks = {
      approvalPolicies,
      budgetRef: asString(policy.budgetRef) ?? undefined,
      subject: { kind: 'Orchestration', name: parsed.name, namespace: parsed.namespace },
    }

    const kube = getKubeClient(deps)
    try {
      await store.ready
      await (deps.validatePolicies ?? defaultValidatePolicies)(parsed.namespace, policyChecks, kube)
      await store.createAuditEvent({
        entityType: 'PolicyDecision',
        entityId: randomUUID(),
        eventType: 'policy.allowed',
        context: auditContext,
        details: { subject: policyChecks.subject, checks: policyChecks },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await store.createAuditEvent({
          entityType: 'PolicyDecision',
          entityId: randomUUID(),
          eventType: 'policy.denied',
          context: auditContext,
          details: { subject: policyChecks.subject, checks: policyChecks, reason: message },
        })
      } catch {
        // Audit failures must not mask the policy denial.
      }
      return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 403)
    }

    const resource = {
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'Orchestration',
      metadata: {
        name: parsed.name,
        namespace: parsed.namespace,
        labels: buildDeliveryIdLabels(deliveryId),
      },
      spec: parsed.spec,
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const uid = asString(metadata.uid)

    if (uid) {
      await store.createAuditEvent({
        entityType: 'Orchestration',
        entityId: uid,
        eventType: 'orchestration.created',
        context: auditContext,
        details: { name: parsed.name, orchestrationUid: uid },
      })
    }

    return okResponse({ ok: true, orchestration: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
