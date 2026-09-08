import { describe, expect, it, vi } from 'vitest'

import { RESOURCE_MAP } from '../kube-types'

import { createWorkflowReconciler } from './workflow-reconciler'

const makeDependencies = (overrides: Partial<Parameters<typeof createWorkflowReconciler>[0]> = {}) => ({
  resolveRunnerServiceAccount: vi.fn(() => 'codex-linear-runner'),
  resolveJobImage: vi.fn(() => 'registry.example/runner:latest'),
  validateImplementationContract: vi.fn(() => ({ ok: true as const, requiredKeys: [] })),
  buildContractStatus: vi.fn(() => undefined),
  buildConditions: vi.fn(() => []),
  setStatus: vi.fn(async () => undefined),
  nowIso: () => '2026-07-20T00:00:00.000Z',
  submitJobRun: vi.fn(async () => ({ type: 'workflow' as const, name: 'run-step', namespace: 'agents' })),
  applyJobTtlAfterStatus: vi.fn(async () => undefined),
  normalizeLabelValue: (value: string) => value,
  verifyJobConfigMaps: vi.fn(async () => ({ ok: true as const, names: [] })),
  isJobComplete: vi.fn(() => false),
  isJobFailed: vi.fn(() => false),
  ...overrides,
})

const agent = {
  metadata: { name: 'codex-linear-agent' },
  spec: {
    providerRef: { name: 'codex-linear' },
    security: {
      allowedSecrets: ['codex-auth'],
      allowedServiceAccounts: ['codex-linear-runner'],
      allowedImplementationSourceProviders: ['linear'],
    },
  },
}

const provider = {
  metadata: { name: 'codex-linear' },
  spec: { workload: { serviceAccountName: 'codex-linear-runner' } },
}

const agentRun = (sourceProvider: string) => ({
  metadata: { name: 'linear-run', namespace: 'agents' },
  spec: {
    agentRef: { name: 'codex-linear-agent' },
    implementation: {
      inline: {
        text: 'Implement the issue.',
        source: { provider: sourceProvider, externalId: 'PROOMPT-123' },
      },
    },
    runtime: { type: 'workflow', config: {} },
    secrets: ['codex-auth'],
  },
})

const kube = {
  get: vi.fn(async (resource: string) => {
    if (resource === RESOURCE_MAP.Agent) return agent
    if (resource === RESOURCE_MAP.AgentProvider) return provider
    return null
  }),
}

describe('workflow source and workload identity policy', () => {
  it('resolves the provider service account when validating a workflow', async () => {
    const dependencies = makeDependencies()
    const reconciler = createWorkflowReconciler(dependencies)

    const result = await reconciler.loadWorkflowDependencies(kube as never, agentRun('linear'), 'agents', [], {})

    expect(result.ok).toBe(true)
    expect(dependencies.resolveRunnerServiceAccount).toHaveBeenCalledWith({}, provider)
  })

  it('rejects a workflow implementation outside the Agent source allowlist', async () => {
    const dependencies = makeDependencies()
    const reconciler = createWorkflowReconciler(dependencies)

    const result = await reconciler.loadWorkflowDependencies(kube as never, agentRun('github'), 'agents', [], {})

    expect(result).toEqual({
      ok: false,
      reason: 'ImplementationSourceProviderNotAllowed',
      message: 'implementation source provider github is not allowlisted',
    })
  })
})
