import { describe, expect, it, vi } from 'vitest'

import type { TokenReviewIdentity } from '../linear-mcp/identity'
import { RESOURCE_MAP } from '../server/kube-types'

import { createAutoOntologyIdentityVerifier } from './identity'

const config = {
  namespace: 'agents',
  audience: 'agents.proompteng.ai/auto-ontology-mcp',
  expectedServiceAccount: 'codex-auto-ontology-runner',
}

const review: TokenReviewIdentity = {
  authenticated: true,
  audiences: [config.audience],
  username: `system:serviceaccount:agents:${config.expectedServiceAccount}`,
  groups: ['system:serviceaccounts:agents'],
  extra: {
    'authentication.kubernetes.io/pod-name': ['run-pod'],
    'authentication.kubernetes.io/pod-uid': ['pod-uid'],
  },
  error: null,
}

const fixture = (overrides: Partial<TokenReviewIdentity> = {}) => {
  const pod = {
    metadata: {
      uid: 'pod-uid',
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'run-job', uid: 'job-uid' }],
    },
    spec: { serviceAccountName: config.expectedServiceAccount },
  }
  const job = {
    metadata: {
      uid: 'job-uid',
      ownerReferences: [
        {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          name: 'run',
          uid: 'run-uid',
        },
      ],
      labels: { 'agents.proompteng.ai/agent-run': 'run', 'agents.proompteng.ai/provider': 'codex' },
    },
  }
  const run = {
    metadata: { uid: 'run-uid', deletionTimestamp: '' },
    spec: { agentRef: { name: 'any-agent-using-codex' } },
    status: { phase: 'Running' },
  }
  const agent = { spec: { providerRef: { name: 'codex' } } }
  const provider = {
    spec: {
      workload: {
        serviceAccountName: config.expectedServiceAccount,
        serviceAccountToken: { audience: config.audience },
      },
    },
  }
  const resources = new Map<string, Record<string, unknown>>([
    ['pod/run-pod', pod],
    ['job/run-job', job],
    [`${RESOURCE_MAP.AgentRun}/run`, run],
    [`${RESOURCE_MAP.Agent}/any-agent-using-codex`, agent],
    [`${RESOURCE_MAP.AgentProvider}/codex`, provider],
  ])
  const get = vi.fn(async (kind: string, name: string, namespace: string) => {
    expect(namespace).toBe(config.namespace)
    return resources.get(`${kind}/${name}`) ?? null
  })
  const reviewToken = vi.fn(async () => ({ ...review, ...overrides }))
  const verify = createAutoOntologyIdentityVerifier(config, { get }, reviewToken)
  return { pod, job, run, agent, provider, get, reviewToken, verify }
}

describe('Auto Ontology MCP projected identity', () => {
  it('authenticates any active AgentRun using the standard Codex provider', async () => {
    const { get, reviewToken, verify } = fixture()
    await expect(verify('projected-token')).resolves.toBeUndefined()
    expect(reviewToken).toHaveBeenCalledWith('projected-token', config.audience)
    expect(get).toHaveBeenCalledWith(RESOURCE_MAP.AgentProvider, 'codex', config.namespace)
  })

  it.each([
    [{ authenticated: false }, 401],
    [{ audiences: ['agents.proompteng.ai/linear-mcp'] }, 401],
    [{ username: 'system:serviceaccount:agents:another-runner' }, 403],
    [{ groups: ['system:serviceaccounts:other-namespace'] }, 403],
    [{ extra: {} }, 403],
  ] satisfies [Partial<TokenReviewIdentity>, number][])(
    'rejects the wrong token identity before resource lookups (%j)',
    async (overrides, status) => {
      const { get, verify } = fixture(overrides)
      await expect(verify('projected-token')).rejects.toMatchObject({ status })
      expect(get).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'pod UID',
      (value: ReturnType<typeof fixture>) => {
        value.pod.metadata.uid = 'recreated'
      },
    ],
    [
      'pod service account',
      (value: ReturnType<typeof fixture>) => {
        value.pod.spec.serviceAccountName = 'other'
      },
    ],
    [
      'job UID',
      (value: ReturnType<typeof fixture>) => {
        value.job.metadata.uid = 'recreated'
      },
    ],
    [
      'job owner group',
      (value: ReturnType<typeof fixture>) => {
        value.job.metadata.ownerReferences[0]!.apiVersion = 'other/v1'
      },
    ],
    [
      'job run label',
      (value: ReturnType<typeof fixture>) => {
        value.job.metadata.labels['agents.proompteng.ai/agent-run'] = 'other'
      },
    ],
    [
      'run UID',
      (value: ReturnType<typeof fixture>) => {
        value.run.metadata.uid = 'recreated'
      },
    ],
    [
      'run deletion',
      (value: ReturnType<typeof fixture>) => {
        value.run.metadata.deletionTimestamp = '2026-01-01'
      },
    ],
    [
      'agent provider',
      (value: ReturnType<typeof fixture>) => {
        value.agent.spec.providerRef.name = 'other'
      },
    ],
    [
      'provider workload audience',
      (value: ReturnType<typeof fixture>) => {
        value.provider.spec.workload.serviceAccountToken.audience = 'other'
      },
    ],
  ] as const)('fails closed on a mismatched %s', async (_description, change) => {
    const state = fixture()
    change(state)
    await expect(state.verify('projected-token')).rejects.toMatchObject({ status: 403, code: 'identity_denied' })
  })

  it('rechecks active phase on each request', async () => {
    const { run, verify } = fixture()
    await verify('projected-token')
    run.status.phase = 'Succeeded'
    await expect(verify('projected-token')).rejects.toMatchObject({ status: 403, code: 'agent_run_inactive' })
  })
})
