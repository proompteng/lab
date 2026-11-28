import { expect, it, vi } from 'vitest'

import type { TokenReviewIdentity } from '../linear-mcp/identity'
import { RESOURCE_MAP } from '../server/kube-types'
import { createMcpRunIdentityVerifier } from '../server/mcp-run-identity'
import { COLAB_AUDIENCE, resolveColabGatewayConfig } from './config'

const config = { ...resolveColabGatewayConfig({}), audience: COLAB_AUDIENCE }
const fixture = (providerName: 'codex' | 'google', review: Partial<TokenReviewIdentity> = {}) => {
  const serviceAccount = config.serviceAccountsByProvider[providerName]
  const pod = {
    metadata: {
      uid: 'pod-uid',
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'run-job', uid: 'job-uid' }],
    },
    spec: { serviceAccountName: serviceAccount },
  }
  const job = {
    metadata: {
      uid: 'job-uid',
      ownerReferences: [{ apiVersion: 'agents.proompteng.ai/v1alpha1', kind: 'AgentRun', name: 'run', uid: 'run-uid' }],
      labels: { 'agents.proompteng.ai/agent-run': 'run', 'agents.proompteng.ai/provider': providerName },
    },
  }
  const run = {
    metadata: { uid: 'run-uid' },
    spec: { agentRef: { name: 'agent' } },
    status: { phase: 'Running' },
  }
  const provider = {
    spec: {
      workload: {
        serviceAccountName: serviceAccount,
        serviceAccountToken: { audience: 'agents.proompteng.ai/auto-ontology-mcp' },
        additionalServiceAccountTokens: [{ audience: COLAB_AUDIENCE }],
      },
    },
  }
  const resources: Record<string, Record<string, unknown>> = {
    'pod/run-pod': pod,
    'job/run-job': job,
    [`${RESOURCE_MAP.AgentRun}/run`]: run,
    [`${RESOURCE_MAP.Agent}/agent`]: { spec: { providerRef: { name: providerName } } },
    [`${RESOURCE_MAP.AgentProvider}/${providerName}`]: provider,
  }
  const get = vi.fn(async (resource: string, name: string, namespace: string) => {
    expect(namespace).toBe('agents')
    return resources[`${resource}/${name}`] ?? null
  })
  const reviewToken = vi.fn(
    async (): Promise<TokenReviewIdentity> => ({
      authenticated: true,
      audiences: [COLAB_AUDIENCE],
      username: `system:serviceaccount:agents:${serviceAccount}`,
      groups: ['system:serviceaccounts:agents'],
      error: null,
      extra: {
        'authentication.kubernetes.io/pod-name': ['run-pod'],
        'authentication.kubernetes.io/pod-uid': ['pod-uid'],
      },
      ...review,
    }),
  )
  return {
    verify: createMcpRunIdentityVerifier(config, { get }, reviewToken),
    reviewToken,
    get,
    run,
    pod,
    job,
    provider,
  }
}

it.each(['codex', 'google'] as const)('validates the projected token and active %s owner chain', async (provider) => {
  const { verify, reviewToken, run } = fixture(provider)
  await expect(verify('projected-token')).resolves.toEqual({
    agentRun: 'run',
    namespace: 'agents',
    serviceAccount: config.serviceAccountsByProvider[provider],
  })
  expect(reviewToken).toHaveBeenCalledWith('projected-token', COLAB_AUDIENCE)
  run.status.phase = 'Succeeded'
  await expect(verify('projected-token')).rejects.toMatchObject({ code: 'agent_run_inactive' })
  expect(reviewToken).toHaveBeenCalledTimes(2)
})

it.each([
  [{ authenticated: false }, 401],
  [{ audiences: ['agents.proompteng.ai/auto-ontology-mcp'] }, 401],
  [{ username: 'system:serviceaccount:other:google-triage-runner' }, 403],
  [{ extra: {} }, 403],
] satisfies [Partial<TokenReviewIdentity>, number][])(
  'rejects invalid TokenReview identity %j',
  async (review, status) => {
    const { verify, get } = fixture('google', review)
    await expect(verify('projected-token')).rejects.toMatchObject({ status })
    expect(get).not.toHaveBeenCalled()
  },
)

it('rejects a recycled Pod, provider/account mismatch, or revoked projection', async () => {
  const { verify, pod, job, provider } = fixture('google')
  pod.metadata.uid = 'recycled-pod'
  await expect(verify('projected-token')).rejects.toMatchObject({ code: 'identity_denied' })
  pod.metadata.uid = 'pod-uid'
  job.metadata.labels['agents.proompteng.ai/provider'] = 'codex'
  await expect(verify('projected-token')).rejects.toMatchObject({ code: 'identity_denied' })
  job.metadata.labels['agents.proompteng.ai/provider'] = 'google'
  provider.spec.workload.additionalServiceAccountTokens = []
  await expect(verify('projected-token')).rejects.toMatchObject({ code: 'identity_denied' })
})
