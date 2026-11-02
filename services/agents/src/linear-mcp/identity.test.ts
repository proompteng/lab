import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP, type KubernetesClient } from '../server/kube-types'

import { createLinearMcpIdentityVerifier, type TokenReviewIdentity } from './identity'

const ISSUE_UUID = '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9'

const config = {
  namespace: 'agents',
  audience: 'agents.proompteng.ai/linear-mcp',
  expectedServiceAccount: 'codex-linear-runner',
  expectedAgent: 'codex-linear-agent',
  expectedProvider: 'codex-linear',
}

const review: TokenReviewIdentity = {
  authenticated: true,
  audiences: [config.audience],
  username: 'system:serviceaccount:agents:codex-linear-runner',
  groups: ['system:serviceaccounts', 'system:serviceaccounts:agents'],
  extra: {
    'authentication.kubernetes.io/pod-name': ['linear-run-job-pod'],
    'authentication.kubernetes.io/pod-uid': ['pod-uid-1'],
  },
  error: null,
}

const resources = () =>
  new Map<string, Record<string, unknown>>([
    [
      'pod/linear-run-job-pod',
      {
        metadata: {
          uid: 'pod-uid-1',
          ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'linear-run-job', uid: 'job-uid-1' }],
        },
        spec: { serviceAccountName: 'codex-linear-runner' },
      },
    ],
    [
      'job/linear-run-job',
      {
        metadata: {
          uid: 'job-uid-1',
          labels: {
            'agents.proompteng.ai/agent': 'codex-linear-agent',
            'agents.proompteng.ai/provider': 'codex-linear',
            'agents.proompteng.ai/agent-run': 'linear-run',
          },
          ownerReferences: [
            {
              apiVersion: 'agents.proompteng.ai/v1alpha1',
              kind: 'AgentRun',
              name: 'linear-run',
              uid: 'run-uid-1',
            },
          ],
        },
      },
    ],
    [
      `${RESOURCE_MAP.AgentRun}/linear-run`,
      {
        metadata: { uid: 'run-uid-1' },
        spec: {
          agentRef: { name: 'codex-linear-agent' },
          implementation: {
            inline: {
              source: { provider: 'linear', externalId: 'PROOMPT-123', url: 'https://linear.app/issue/PROOMPT-123' },
              metadata: { issueId: ISSUE_UUID },
            },
          },
        },
        status: { phase: 'Running' },
      },
    ],
    [
      `${RESOURCE_MAP.Agent}/codex-linear-agent`,
      {
        spec: {
          providerRef: { name: 'codex-linear' },
          security: {
            allowedServiceAccounts: ['codex-linear-runner'],
            allowedImplementationSourceProviders: ['linear'],
          },
        },
      },
    ],
    [
      `${RESOURCE_MAP.AgentProvider}/codex-linear`,
      {
        spec: {
          workload: {
            serviceAccountName: 'codex-linear-runner',
            serviceAccountToken: { audience: 'agents.proompteng.ai/linear-mcp' },
          },
        },
      },
    ],
  ])

const makeKube = (values: Map<string, Record<string, unknown>>) =>
  ({
    get: vi.fn(async (resource: string, name: string) => values.get(`${resource}/${name}`) ?? null),
  }) as unknown as KubernetesClient

describe('Linear MCP workload identity', () => {
  it('verifies TokenReview and the complete Pod to Job to AgentRun owner chain', async () => {
    const verifier = createLinearMcpIdentityVerifier({
      config,
      tokenReviewer: vi.fn(async () => review),
      kube: makeKube(resources()),
    })

    await expect(verifier.verify('bound-token')).resolves.toMatchObject({
      podUid: 'pod-uid-1',
      jobUid: 'job-uid-1',
      agentRunUid: 'run-uid-1',
      issueIdentifier: 'PROOMPT-123',
      issueUuid: ISSUE_UUID,
    })
  })

  it('rejects a Pod UID substitution before trusting its owner chain', async () => {
    const values = resources()
    ;(values.get('pod/linear-run-job-pod')!.metadata as Record<string, unknown>).uid = 'different-pod-uid'
    const verifier = createLinearMcpIdentityVerifier({
      config,
      tokenReviewer: vi.fn(async () => review),
      kube: makeKube(values),
    })

    await expect(verifier.verify('bound-token')).rejects.toMatchObject({
      code: 'identity_denied',
      message: 'Pod owner UID does not match',
    })
  })

  it('revokes access as soon as the AgentRun becomes terminal', async () => {
    const values = resources()
    ;(values.get(`${RESOURCE_MAP.AgentRun}/linear-run`)!.status as Record<string, unknown>).phase = 'Succeeded'
    const verifier = createLinearMcpIdentityVerifier({
      config,
      tokenReviewer: vi.fn(async () => review),
      kube: makeKube(values),
    })

    await expect(verifier.verify('bound-token')).rejects.toMatchObject({
      code: 'agent_run_inactive',
    })
  })

  it('rejects access when the Agent no longer allows Linear sources', async () => {
    const values = resources()
    const agent = values.get(`${RESOURCE_MAP.Agent}/codex-linear-agent`)!
    ;(readSecurity(agent).allowedImplementationSourceProviders as string[]) = ['github']
    const verifier = createLinearMcpIdentityVerifier({
      config,
      tokenReviewer: vi.fn(async () => review),
      kube: makeKube(values),
    })

    await expect(verifier.verify('bound-token')).rejects.toMatchObject({
      message: 'Agent does not allow Linear implementation sources',
    })
  })

  it('rejects a manually submitted Linear source without an immutable issue UUID', async () => {
    const values = resources()
    const run = values.get(`${RESOURCE_MAP.AgentRun}/linear-run`)!
    const spec = run.spec as Record<string, unknown>
    const implementation = spec.implementation as Record<string, unknown>
    const inline = implementation.inline as Record<string, unknown>
    inline.metadata = { issueId: 'PROOMPT-123' }
    const verifier = createLinearMcpIdentityVerifier({
      config,
      tokenReviewer: vi.fn(async () => review),
      kube: makeKube(values),
    })

    await expect(verifier.verify('bound-token')).rejects.toMatchObject({
      message: 'AgentRun Linear source identity is incomplete',
    })
  })
})

const readSecurity = (agent: Record<string, unknown>) =>
  (agent.spec as Record<string, unknown>).security as Record<string, unknown>
