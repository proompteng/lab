import { type KubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const asArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const readNested = (obj: Record<string, unknown>, path: string[]) => {
  let cursor: unknown = obj
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
}

export type PolicyChecks = {
  approvalPolicies?: string[]
  budgetRef?: string
  secretBindingRef?: string
  requiredSecrets?: string[]
  subject?: { kind: string; name: string; namespace?: string }
}

export const validateApprovalPolicies = async (namespace: string, policies: string[], kube: KubernetesClient) => {
  const missing: string[] = []
  for (const policy of policies) {
    const resource = await kube.get(RESOURCE_MAP.ApprovalPolicy, policy, namespace)
    if (!resource) missing.push(policy)
  }
  if (missing.length > 0) {
    throw new Error(`approval policies not found: ${missing.join(', ')}`)
  }
}

export const validateBudget = async (namespace: string, budgetRef: string, kube: KubernetesClient) => {
  const budget = await kube.get(RESOURCE_MAP.Budget, budgetRef, namespace)
  if (!budget) {
    throw new Error(`budget not found: ${budgetRef}`)
  }
}

export const validateSecretBinding = async (
  namespace: string,
  bindingName: string,
  subject: { kind: string; name: string; namespace?: string },
  requiredSecrets: string[],
  kube: KubernetesClient,
) => {
  const binding = await kube.get(RESOURCE_MAP.SecretBinding, bindingName, namespace)
  if (!binding) {
    throw new Error(`secret binding not found: ${bindingName}`)
  }

  const spec = readNested(binding, ['spec']) as Record<string, unknown> | null
  const subjects = Array.isArray(spec?.subjects) ? (spec?.subjects as Record<string, unknown>[]) : []
  const allowedSecrets = asArray(spec?.allowedSecrets)

  const matchesSubject = subjects.some((entry) => {
    const kind = asString(entry.kind)
    const name = asString(entry.name)
    const subjectNamespace = asString(entry.namespace)
    if (!kind || !name) return false
    if (kind !== subject.kind || name !== subject.name) return false
    if (subjectNamespace && subject.namespace && subjectNamespace !== subject.namespace) return false
    return true
  })

  if (!matchesSubject) {
    throw new Error(`secret binding ${bindingName} does not include subject ${subject.kind}/${subject.name}`)
  }

  const missingSecrets = requiredSecrets.filter((secret) => !allowedSecrets.includes(secret))
  if (missingSecrets.length > 0) {
    throw new Error(`secret binding ${bindingName} missing secrets: ${missingSecrets.join(', ')}`)
  }
}

export const validatePolicies = async (namespace: string, checks: PolicyChecks, kube: KubernetesClient) => {
  const approvalPolicies = asArray(checks.approvalPolicies)
  if (approvalPolicies.length > 0) {
    await validateApprovalPolicies(namespace, approvalPolicies, kube)
  }

  const budgetRef = asString(checks.budgetRef)
  if (budgetRef) {
    await validateBudget(namespace, budgetRef, kube)
  }

  const bindingRef = asString(checks.secretBindingRef)
  if (bindingRef) {
    const subject = checks.subject
    if (!subject) {
      throw new Error('secret binding requires a subject')
    }
    await validateSecretBinding(namespace, bindingRef, subject, asArray(checks.requiredSecrets), kube)
  }
}

export const extractApprovalPolicies = (steps: Array<Record<string, unknown>>) => {
  const policies: string[] = []
  for (const step of steps) {
    const policyRef = asString(step.policyRef)
    if (policyRef) policies.push(policyRef)
  }
  return policies
}

export const extractRequiredSecrets = (spec: Record<string, unknown>) => {
  const security = (spec.security ?? {}) as Record<string, unknown>
  return asArray(security.allowedSecrets)
}

export const extractAllowedServiceAccounts = (spec: Record<string, unknown>) => {
  const security = (spec.security ?? {}) as Record<string, unknown>
  return asArray(security.allowedServiceAccounts)
}

export const extractRuntimeServiceAccount = (spec: Record<string, unknown>) => {
  const runtime = (spec.runtime ?? {}) as Record<string, unknown>
  const argo = (runtime.argo ?? {}) as Record<string, unknown>
  return asString(argo.serviceAccount)
}
