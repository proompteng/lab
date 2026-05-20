import {
  fetchApprovalPolicyResourceFromAgentsService,
  fetchBudgetResourceFromAgentsService,
  fetchSecretBindingResourceFromAgentsService,
} from '@proompteng/agent-contracts/policy-reference-client'
import {
  extractAllowedServiceAccounts,
  extractApprovalPolicies,
  extractRequiredSecrets,
  extractRuntimeServiceAccount,
  validateApprovalPolicies as validateApprovalPoliciesWithGetter,
  validateBudget as validateBudgetWithGetter,
  validatePolicies as validatePoliciesWithGetter,
  validateSecretBinding as validateSecretBindingWithGetter,
  type PolicyChecks,
  type PolicyResourceGetter,
  type PolicySubject,
} from '@proompteng/agent-contracts/policy-validation'

import { asRecord } from '@proompteng/agent-contracts/json'

export type { PolicyChecks, PolicyResourceGetter, PolicySubject }
export { extractAllowedServiceAccounts, extractApprovalPolicies, extractRequiredSecrets, extractRuntimeServiceAccount }

const getPolicyResourceFromAgentsService: PolicyResourceGetter = async (kind, name, namespace) => {
  const result =
    kind === 'ApprovalPolicy'
      ? await fetchApprovalPolicyResourceFromAgentsService({ name, namespace })
      : kind === 'Budget'
        ? await fetchBudgetResourceFromAgentsService({ name, namespace })
        : await fetchSecretBindingResourceFromAgentsService({ name, namespace })
  if (result.ok) {
    return asRecord(result.body.resource)
  }
  if (result.status === 404) {
    return null
  }
  throw new Error(result.error ?? `Agents service returned HTTP ${result.status}`)
}

export const validateApprovalPolicies = async (
  namespace: string,
  policies: string[],
  getResource: PolicyResourceGetter = getPolicyResourceFromAgentsService,
) => validateApprovalPoliciesWithGetter(namespace, policies, getResource)

export const validateBudget = async (
  namespace: string,
  budgetRef: string,
  getResource: PolicyResourceGetter = getPolicyResourceFromAgentsService,
) => validateBudgetWithGetter(namespace, budgetRef, getResource)

export const validateSecretBinding = async (
  namespace: string,
  bindingName: string,
  subject: PolicySubject,
  requiredSecrets: string[],
  getResource: PolicyResourceGetter = getPolicyResourceFromAgentsService,
) => validateSecretBindingWithGetter(namespace, bindingName, subject, requiredSecrets, getResource)

export const validatePolicies = async (
  namespace: string,
  checks: PolicyChecks,
  getResource: PolicyResourceGetter = getPolicyResourceFromAgentsService,
) => validatePoliciesWithGetter(namespace, checks, getResource)
