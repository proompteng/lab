import { type KubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

const asArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const parseNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const parseQuantity = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)([a-zA-Z]+)?$/)
  if (!match) return null
  const amount = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(amount)) return null
  const suffix = match[2] ?? ''
  if (!suffix) return amount
  if (suffix === 'm') return amount / 1000

  const binary = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  } as const
  const decimal = {
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  } as const

  if (suffix in binary) {
    return amount * binary[suffix as keyof typeof binary]
  }
  if (suffix in decimal) {
    return amount * decimal[suffix as keyof typeof decimal]
  }

  return amount
}

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
    if (!resource) {
      missing.push(policy)
      continue
    }
    const phase = asString(readNested(resource, ['status', 'phase']))?.toLowerCase()
    if (phase && ['denied', 'rejected', 'blocked', 'failed'].includes(phase)) {
      throw new Error(`approval policy ${policy} is ${phase}`)
    }
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

  const phase = asString(readNested(budget, ['status', 'phase']))?.toLowerCase()
  if (phase && ['exceeded', 'blocked', 'failed', 'denied'].includes(phase)) {
    throw new Error(`budget ${budgetRef} is ${phase}`)
  }

  const limits = (readNested(budget, ['spec', 'limits']) ?? {}) as Record<string, unknown>
  const used = (readNested(budget, ['status', 'used']) ?? {}) as Record<string, unknown>

  const tokensLimit = parseNumber(limits.tokens)
  const tokensUsed = parseNumber(used.tokens)
  if (tokensLimit != null && tokensUsed != null && tokensUsed > tokensLimit) {
    throw new Error(`budget ${budgetRef} tokens exceeded (${tokensUsed}/${tokensLimit})`)
  }

  const dollarsLimit = parseNumber(limits.dollars)
  const dollarsUsed = parseNumber(used.dollars)
  if (dollarsLimit != null && dollarsUsed != null && dollarsUsed > dollarsLimit) {
    throw new Error(`budget ${budgetRef} dollars exceeded (${dollarsUsed}/${dollarsLimit})`)
  }

  const cpuLimit = parseQuantity(limits.cpu)
  const cpuUsed = parseQuantity(used.cpu)
  if (cpuLimit != null && cpuUsed != null && cpuUsed > cpuLimit) {
    throw new Error(`budget ${budgetRef} cpu exceeded (${used.cpu}/${limits.cpu})`)
  }

  const memoryLimit = parseQuantity(limits.memory)
  const memoryUsed = parseQuantity(used.memory)
  if (memoryLimit != null && memoryUsed != null && memoryUsed > memoryLimit) {
    throw new Error(`budget ${budgetRef} memory exceeded (${used.memory}/${limits.memory})`)
  }

  const gpuLimit = parseQuantity(limits.gpu)
  const gpuUsed = parseQuantity(used.gpu)
  if (gpuLimit != null && gpuUsed != null && gpuUsed > gpuLimit) {
    throw new Error(`budget ${budgetRef} gpu exceeded (${used.gpu}/${limits.gpu})`)
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
