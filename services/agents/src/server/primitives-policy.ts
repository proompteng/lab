import {
  extractAllowedImplementationSourceProviders,
  extractAllowedServiceAccounts,
  extractApprovalPolicies,
  extractRequiredSecrets,
  extractImplementationSourceProvider,
  extractProviderServiceAccount,
  extractRuntimeServiceAccount,
  resolveEffectiveServiceAccount,
  validateApprovalPolicies as validateApprovalPoliciesWithGetter,
  validateBudget as validateBudgetWithGetter,
  validatePolicies as validatePoliciesWithGetter,
  validateSecretBinding as validateSecretBindingWithGetter,
  type PolicyChecks,
  type PolicyResourceGetter,
  type PolicyResourceKind,
  type PolicySubject,
} from '@proompteng/agent-contracts'

import { type KubernetesClient, RESOURCE_MAP } from './kube-types'

export type { PolicyChecks, PolicyResourceGetter, PolicyResourceKind, PolicySubject }
export {
  extractAllowedImplementationSourceProviders,
  extractAllowedServiceAccounts,
  extractApprovalPolicies,
  extractImplementationSourceProvider,
  extractProviderServiceAccount,
  extractRequiredSecrets,
  extractRuntimeServiceAccount,
  resolveEffectiveServiceAccount,
}

const POLICY_RESOURCE_MAP = {
  ApprovalPolicy: RESOURCE_MAP.ApprovalPolicy,
  Budget: RESOURCE_MAP.Budget,
  SecretBinding: RESOURCE_MAP.SecretBinding,
} satisfies Record<PolicyResourceKind, string>

const createKubePolicyResourceGetter =
  (kube: KubernetesClient): PolicyResourceGetter =>
  async (kind, name, namespace) =>
    kube.get(POLICY_RESOURCE_MAP[kind], name, namespace)

export const validateApprovalPolicies = async (namespace: string, policies: string[], kube: KubernetesClient) =>
  validateApprovalPoliciesWithGetter(namespace, policies, createKubePolicyResourceGetter(kube))

export const validateBudget = async (namespace: string, budgetRef: string, kube: KubernetesClient) =>
  validateBudgetWithGetter(namespace, budgetRef, createKubePolicyResourceGetter(kube))

export const validateSecretBinding = async (
  namespace: string,
  bindingName: string,
  subject: PolicySubject,
  requiredSecrets: string[],
  kube: KubernetesClient,
) =>
  validateSecretBindingWithGetter(
    namespace,
    bindingName,
    subject,
    requiredSecrets,
    createKubePolicyResourceGetter(kube),
  )

export const validatePolicies = async (namespace: string, checks: PolicyChecks, kube: KubernetesClient) =>
  validatePoliciesWithGetter(namespace, checks, createKubePolicyResourceGetter(kube))
