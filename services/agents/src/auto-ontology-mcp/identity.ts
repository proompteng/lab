import { createKubernetesTokenReviewer, isActiveAgentRunPhase, type TokenReviewer } from '../linear-mcp/identity'
import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '../server/kube-types'
import { asRecord, asString, readNested } from '../server/primitives'

export class AutoOntologyIdentityError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: 'invalid_token' | 'identity_denied' | 'agent_run_inactive',
  ) {
    super(code)
  }
}

const invalidToken = () => new AutoOntologyIdentityError(401, 'invalid_token')
const denied = () => new AutoOntologyIdentityError(403, 'identity_denied')

const owner = (resource: Record<string, unknown>, apiVersion: string, kind: string) => {
  const refs = readNested(resource, ['metadata', 'ownerReferences'])
  if (Array.isArray(refs)) {
    for (const value of refs) {
      const ref = asRecord(value)
      const name = asString(ref?.name)
      const uid = asString(ref?.uid)
      if (ref?.apiVersion === apiVersion && ref.kind === kind && name && uid) return { name, uid }
    }
  }
  throw denied()
}

type IdentityConfig = { namespace: string; audience: string; expectedServiceAccount: string }

export const createAutoOntologyIdentityVerifier = (
  { namespace, audience, expectedServiceAccount }: IdentityConfig,
  kube: Pick<KubernetesClient, 'get'> = createKubernetesClient(),
  reviewToken: TokenReviewer = createKubernetesTokenReviewer(),
) => {
  const lookup = async (resource: string, name: string, uid?: string) => {
    const value = await kube.get(resource, name, namespace)
    if (!value || readNested(value, ['metadata', 'deletionTimestamp'])) throw denied()
    if (uid && readNested(value, ['metadata', 'uid']) !== uid) throw denied()
    return value
  }

  return async (token: string) => {
    if (!token || token.length > 16_384) throw invalidToken()
    const review = await reviewToken(token, audience)
    if (!review.authenticated || review.error || !review.audiences.includes(audience)) throw invalidToken()
    if (
      review.username !== `system:serviceaccount:${namespace}:${expectedServiceAccount}` ||
      !review.groups.includes(`system:serviceaccounts:${namespace}`)
    ) {
      throw denied()
    }

    const podName = asString(review.extra['authentication.kubernetes.io/pod-name']?.[0])
    const podUid = asString(review.extra['authentication.kubernetes.io/pod-uid']?.[0])
    if (!podName || !podUid) throw denied()

    const pod = await lookup('pod', podName, podUid)
    if (readNested(pod, ['spec', 'serviceAccountName']) !== expectedServiceAccount) throw denied()
    const jobRef = owner(pod, 'batch/v1', 'Job')
    const job = await lookup('job', jobRef.name, jobRef.uid)
    const runRef = owner(job, 'agents.proompteng.ai/v1alpha1', 'AgentRun')
    const labels = asRecord(readNested(job, ['metadata', 'labels']))
    if (
      labels?.['agents.proompteng.ai/agent-run'] !== runRef.name ||
      labels['agents.proompteng.ai/provider'] !== 'codex'
    ) {
      throw denied()
    }

    const run = await lookup(RESOURCE_MAP.AgentRun, runRef.name, runRef.uid)
    if (!isActiveAgentRunPhase(readNested(run, ['status', 'phase']))) {
      throw new AutoOntologyIdentityError(403, 'agent_run_inactive')
    }
    const agentName = asString(readNested(run, ['spec', 'agentRef', 'name']))
    if (!agentName) throw denied()
    const [agent, provider] = await Promise.all([
      lookup(RESOURCE_MAP.Agent, agentName),
      lookup(RESOURCE_MAP.AgentProvider, 'codex'),
    ])
    if (
      readNested(agent, ['spec', 'providerRef', 'name']) !== 'codex' ||
      readNested(provider, ['spec', 'workload', 'serviceAccountName']) !== expectedServiceAccount ||
      readNested(provider, ['spec', 'workload', 'serviceAccountToken', 'audience']) !== audience
    ) {
      throw denied()
    }
  }
}
