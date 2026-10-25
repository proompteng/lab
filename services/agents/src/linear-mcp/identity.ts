import { AuthenticationV1Api, KubeConfig, type V1TokenReview } from '@kubernetes/client-node'

import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '../server/kube-types'
import { asRecord, asString, readNested } from '../server/primitives'

export class LinearMcpIdentityError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 403,
    readonly code = 'identity_denied',
  ) {
    super(message)
    this.name = 'LinearMcpIdentityError'
  }
}

export type TokenReviewIdentity = {
  authenticated: boolean
  audiences: string[]
  username: string | null
  groups: string[]
  extra: Record<string, string[]>
  error: string | null
}

export type LinearMcpRunIdentity = {
  namespace: string
  podName: string
  podUid: string
  jobName: string
  jobUid: string
  agentRunName: string
  agentRunUid: string
  agentName: string
  providerName: string
  issueIdentifier: string
  issueUuid: string
  issueUrl: string | null
  phase: string
}

export type LinearMcpIdentityVerifier = {
  verify: (token: string) => Promise<LinearMcpRunIdentity>
}

export type LinearMcpIdentityConfig = {
  namespace: string
  audience: string
  expectedServiceAccount: string
  expectedAgent: string
  expectedProvider: string
}

export type TokenReviewer = (token: string, audience: string) => Promise<TokenReviewIdentity>

const firstExtra = (extra: Record<string, string[]>, key: string) => extra[key]?.[0]?.trim() || null

const normalizedStringSet = (value: unknown, normalize: (entry: string) => string = (entry) => entry) =>
  new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map(normalize),
  )

const ownerReference = (resource: Record<string, unknown>, kind: string) => {
  const references = readNested(resource, ['metadata', 'ownerReferences'])
  if (!Array.isArray(references)) return null
  return (
    references
      .map((value) => asRecord(value))
      .find((value) => asString(value?.kind) === kind && asString(value?.name) && asString(value?.uid)) ?? null
  )
}

const requireResource = async (kube: KubernetesClient, resource: string, name: string, namespace: string) => {
  const value = await kube.get(resource, name, namespace)
  if (!value) throw new LinearMcpIdentityError(`${resource} owner not found`)
  return value
}

const requireUid = (resource: Record<string, unknown>, expected: string, kind: string) => {
  const uid = asString(readNested(resource, ['metadata', 'uid']))
  if (!uid || uid !== expected) throw new LinearMcpIdentityError(`${kind} owner UID does not match`)
}

const ACTIVE_PHASES = new Set(['pending', 'queued', 'progressing', 'inprogress', 'running'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isActiveAgentRunPhase = (value: unknown) => {
  const phase = asString(value)?.toLowerCase() ?? 'pending'
  return ACTIVE_PHASES.has(phase)
}

export const createLinearMcpIdentityVerifier = (options: {
  config: LinearMcpIdentityConfig
  tokenReviewer: TokenReviewer
  kube?: KubernetesClient
}): LinearMcpIdentityVerifier => {
  const kube = options.kube ?? createKubernetesClient()
  const { config } = options
  const expectedUsername = `system:serviceaccount:${config.namespace}:${config.expectedServiceAccount}`

  return {
    verify: async (token) => {
      if (!token || token.length > 16_384) {
        throw new LinearMcpIdentityError('missing or invalid bearer token', 401, 'invalid_token')
      }
      const review = await options.tokenReviewer(token, config.audience)
      if (!review.authenticated || review.error) {
        throw new LinearMcpIdentityError('bearer token was not authenticated', 401, 'invalid_token')
      }
      if (review.username !== expectedUsername) {
        throw new LinearMcpIdentityError('service account is not allowed')
      }
      if (!review.audiences.includes(config.audience)) {
        throw new LinearMcpIdentityError('bearer token audience does not match', 401, 'invalid_token')
      }
      if (!review.groups.includes(`system:serviceaccounts:${config.namespace}`)) {
        throw new LinearMcpIdentityError('service account namespace does not match')
      }

      const podName = firstExtra(review.extra, 'authentication.kubernetes.io/pod-name')
      const podUid = firstExtra(review.extra, 'authentication.kubernetes.io/pod-uid')
      if (!podName || !podUid) {
        throw new LinearMcpIdentityError('bearer token is not bound to a Pod')
      }

      const pod = await requireResource(kube, 'pod', podName, config.namespace)
      requireUid(pod, podUid, 'Pod')
      if (asString(readNested(pod, ['spec', 'serviceAccountName'])) !== config.expectedServiceAccount) {
        throw new LinearMcpIdentityError('Pod service account does not match')
      }
      const jobOwner = ownerReference(pod, 'Job')
      const jobName = asString(jobOwner?.name)
      const jobUid = asString(jobOwner?.uid)
      if (!jobName || !jobUid || asString(jobOwner?.apiVersion) !== 'batch/v1') {
        throw new LinearMcpIdentityError('Pod is not owned by an expected Job')
      }

      const job = await requireResource(kube, 'job', jobName, config.namespace)
      requireUid(job, jobUid, 'Job')
      if (asString(readNested(job, ['metadata', 'labels', 'agents.proompteng.ai/agent'])) !== config.expectedAgent) {
        throw new LinearMcpIdentityError('Job agent identity does not match')
      }
      if (
        asString(readNested(job, ['metadata', 'labels', 'agents.proompteng.ai/provider'])) !== config.expectedProvider
      ) {
        throw new LinearMcpIdentityError('Job provider identity does not match')
      }

      const runOwner = ownerReference(job, 'AgentRun')
      const agentRunName = asString(runOwner?.name)
      const agentRunUid = asString(runOwner?.uid)
      if (!agentRunName || !agentRunUid || asString(runOwner?.apiVersion) !== 'agents.proompteng.ai/v1alpha1') {
        throw new LinearMcpIdentityError('Job is not owned by an expected AgentRun')
      }
      if (asString(readNested(job, ['metadata', 'labels', 'agents.proompteng.ai/agent-run'])) !== agentRunName) {
        throw new LinearMcpIdentityError('Job AgentRun label does not match its owner')
      }

      const agentRun = await requireResource(kube, RESOURCE_MAP.AgentRun, agentRunName, config.namespace)
      requireUid(agentRun, agentRunUid, 'AgentRun')
      const phase = asString(readNested(agentRun, ['status', 'phase'])) ?? 'Pending'
      if (!isActiveAgentRunPhase(phase)) {
        throw new LinearMcpIdentityError('AgentRun is no longer active', 403, 'agent_run_inactive')
      }
      const agentName = asString(readNested(agentRun, ['spec', 'agentRef', 'name']))
      if (agentName !== config.expectedAgent) {
        throw new LinearMcpIdentityError('AgentRun agent identity does not match')
      }

      const agent = await requireResource(kube, RESOURCE_MAP.Agent, config.expectedAgent, config.namespace)
      if (asString(readNested(agent, ['spec', 'providerRef', 'name'])) !== config.expectedProvider) {
        throw new LinearMcpIdentityError('Agent provider identity does not match')
      }
      const allowedServiceAccounts = normalizedStringSet(
        readNested(agent, ['spec', 'security', 'allowedServiceAccounts']),
      )
      if (!allowedServiceAccounts.has(config.expectedServiceAccount)) {
        throw new LinearMcpIdentityError('Agent does not allow the runner service account')
      }
      const allowedSourceProviders = normalizedStringSet(
        readNested(agent, ['spec', 'security', 'allowedImplementationSourceProviders']),
        (entry) => entry.toLowerCase(),
      )
      if (!allowedSourceProviders.has('linear')) {
        throw new LinearMcpIdentityError('Agent does not allow Linear implementation sources')
      }
      const provider = await requireResource(
        kube,
        RESOURCE_MAP.AgentProvider,
        config.expectedProvider,
        config.namespace,
      )
      if (
        asString(readNested(provider, ['spec', 'workload', 'serviceAccountName'])) !== config.expectedServiceAccount
      ) {
        throw new LinearMcpIdentityError('AgentProvider service account identity does not match')
      }
      if (asString(readNested(provider, ['spec', 'workload', 'serviceAccountToken', 'audience'])) !== config.audience) {
        throw new LinearMcpIdentityError('AgentProvider token audience does not match')
      }

      const source = asRecord(readNested(agentRun, ['spec', 'implementation', 'inline', 'source']))
      const metadata = asRecord(readNested(agentRun, ['spec', 'implementation', 'inline', 'metadata']))
      if (asString(source?.provider)?.toLowerCase() !== 'linear') {
        throw new LinearMcpIdentityError('AgentRun implementation source is not Linear')
      }
      const issueIdentifier = asString(source?.externalId)
      const issueUuid = asString(metadata?.issueId)
      if (!issueIdentifier || !issueUuid || !UUID_PATTERN.test(issueUuid)) {
        throw new LinearMcpIdentityError('AgentRun Linear source identity is incomplete')
      }

      return {
        namespace: config.namespace,
        podName,
        podUid,
        jobName,
        jobUid,
        agentRunName,
        agentRunUid,
        agentName,
        providerName: config.expectedProvider,
        issueIdentifier,
        issueUuid,
        issueUrl: asString(source?.url),
        phase,
      }
    },
  }
}

export const createKubernetesTokenReviewer = (): TokenReviewer => {
  const config = new KubeConfig()
  config.loadFromDefault()
  const api = config.makeApiClient(AuthenticationV1Api)
  return async (token, audience) => {
    const response = await api.createTokenReview({
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: { token, audiences: [audience] },
      } as V1TokenReview,
    })
    return {
      authenticated: response.status?.authenticated === true,
      audiences: response.status?.audiences ?? [],
      username: response.status?.user?.username?.trim() || null,
      groups: response.status?.user?.groups ?? [],
      extra: response.status?.user?.extra ?? {},
      error: response.status?.error?.trim() || null,
    }
  }
}
