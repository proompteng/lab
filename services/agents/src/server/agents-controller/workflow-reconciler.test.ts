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

  it('rejects a workflow with invalid base or step model/effort overrides as InvalidSpec before submitting jobs', async () => {
    const googleAgent = {
      metadata: { name: 'google-agent' },
      spec: { providerRef: { name: 'google' } },
    }
    const googleProvider = {
      metadata: { name: 'google' },
      spec: {
        binary: '/usr/local/bin/agent-runner',
        adapter: {
          type: 'agy-cli',
          agy: {
            model: 'gemini-4-neon',
            effort: 'high',
            allowedModels: ['gemini-4-neon', 'gemini-2.5-pro'],
          },
        },
      },
    }
    const googleKube = {
      get: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) return googleAgent
        if (resource === RESOURCE_MAP.AgentProvider) return googleProvider
        return null
      }),
    }

    const dependencies = makeDependencies()
    const reconciler = createWorkflowReconciler(dependencies)

    await reconciler.reconcileWorkflowRun(
      googleKube as never,
      {
        metadata: { name: 'google-wf-bad-base', namespace: 'agents', generation: 1 },
        spec: {
          agentRef: { name: 'google-agent' },
          implementation: { inline: { text: 'Implement change.' } },
          parameters: { model: 'gemini-2.0-flash' },
          runtime: { type: 'workflow', config: {} },
          workflow: { steps: [{ name: 'implement' }] },
        },
      },
      'agents',
      [],
      { initialSubmit: true },
    )

    expect(dependencies.submitJobRun).not.toHaveBeenCalled()
    expect(dependencies.setStatus).toHaveBeenLastCalledWith(
      googleKube,
      expect.any(Object),
      expect.objectContaining({
        phase: 'Failed',
        reason: 'ModelOverrideNotAllowed',
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'InvalidSpec',
            status: 'True',
            reason: 'ModelOverrideNotAllowed',
          }),
        ]),
      }),
    )

    await reconciler.reconcileWorkflowRun(
      googleKube as never,
      {
        metadata: { name: 'google-wf-bad-step', namespace: 'agents', generation: 1 },
        spec: {
          agentRef: { name: 'google-agent' },
          implementation: { inline: { text: 'Implement change.' } },
          parameters: { model: 'gemini-2.5-pro' },
          runtime: { type: 'workflow', config: {} },
          workflow: {
            steps: [
              { name: 'plan', parameters: { effort: 'low' } },
              { name: 'implement', parameters: { effort: 'ultra' } },
            ],
          },
        },
      },
      'agents',
      [],
      { initialSubmit: true },
    )

    expect(dependencies.submitJobRun).not.toHaveBeenCalled()
    expect(dependencies.setStatus).toHaveBeenLastCalledWith(
      googleKube,
      expect.any(Object),
      expect.objectContaining({
        phase: 'Failed',
        reason: 'InvalidEffortOverride',
        message: expect.stringContaining('workflow step implement:'),
        conditions: expect.arrayContaining([
          expect.objectContaining({
            type: 'InvalidSpec',
            status: 'True',
            reason: 'InvalidEffortOverride',
          }),
        ]),
      }),
    )
  })
})
