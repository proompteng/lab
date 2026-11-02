import { describe, expect, it, vi } from 'vitest'

import {
  extractAllowedImplementationSourceProviders,
  extractImplementationSourceProvider,
  extractProviderServiceAccount,
  extractRuntimeServiceAccount,
  resolveEffectiveServiceAccount,
  validateApprovalPolicies,
  validateBudget,
  validatePolicies,
  validateSecretBinding,
  type PolicyResourceKind,
} from './policy-validation'

const createResourceGetter = (resources: Record<string, Record<string, unknown> | null>) =>
  vi.fn(
    async (kind: PolicyResourceKind, name: string, namespace: string) =>
      resources[`${kind}:${namespace}:${name}`] ?? null,
  )

describe('policy validation', () => {
  it('rejects missing budget', async () => {
    const getResource = createResourceGetter({})
    await expect(validateBudget('agents', 'missing-budget', getResource)).rejects.toThrow('budget not found')
    expect(getResource).toHaveBeenCalledWith('Budget', 'missing-budget', 'agents')
  })

  it('rejects missing approval policy', async () => {
    const getResource = createResourceGetter({})
    await expect(validateApprovalPolicies('agents', ['missing-policy'], getResource)).rejects.toThrow(
      'approval policies not found',
    )
    expect(getResource).toHaveBeenCalledWith('ApprovalPolicy', 'missing-policy', 'agents')
  })

  it('rejects denied approval policy', async () => {
    const getResource = createResourceGetter({
      'ApprovalPolicy:agents:policy-1': { status: { phase: 'Denied' } },
    })
    await expect(validateApprovalPolicies('agents', ['policy-1'], getResource)).rejects.toThrow(
      'approval policy policy-1 is',
    )
  })

  it('accepts ready approval policy', async () => {
    const getResource = createResourceGetter({
      'ApprovalPolicy:agents:policy-2': { status: { phase: 'Approved' } },
    })
    await expect(validateApprovalPolicies('agents', ['policy-2'], getResource)).resolves.toBeUndefined()
  })

  it('rejects exceeded budget usage', async () => {
    const getResource = createResourceGetter({
      'Budget:agents:budget-1': {
        spec: { limits: { tokens: 1000, dollars: 50 } },
        status: { used: { tokens: 1200, dollars: 60 } },
      },
    })
    await expect(validateBudget('agents', 'budget-1', getResource)).rejects.toThrow('budget budget-1 tokens exceeded')
  })

  it('accepts budget within limits', async () => {
    const getResource = createResourceGetter({
      'Budget:agents:budget-2': {
        spec: { limits: { tokens: 1000, dollars: 50, cpu: '2', memory: '2Gi', gpu: '1' } },
        status: { used: { tokens: 800, dollars: 40, cpu: '500m', memory: '512Mi', gpu: 1 } },
      },
    })
    await expect(validateBudget('agents', 'budget-2', getResource)).resolves.toBeUndefined()
  })

  it('validates secret binding subjects and secrets', async () => {
    const binding = {
      spec: {
        allowedSecrets: ['alpha', 'beta'],
        subjects: [{ kind: 'Agent', name: 'codex-implementation', namespace: 'agents' }],
      },
    }
    const getResource = createResourceGetter({
      'SecretBinding:agents:binding-1': binding,
    })

    await expect(
      validateSecretBinding(
        'agents',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'agents' },
        ['alpha'],
        getResource,
      ),
    ).resolves.toBeUndefined()

    await expect(
      validateSecretBinding(
        'agents',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'agents' },
        ['gamma'],
        getResource,
      ),
    ).rejects.toThrow('missing secrets')
  })

  it('validates a combined policy check with one resource getter', async () => {
    const getResource = createResourceGetter({
      'ApprovalPolicy:agents:approved': { status: { phase: 'Approved' } },
      'Budget:agents:budget': { spec: { limits: { cpu: '2' } }, status: { used: { cpu: '1' } } },
      'SecretBinding:agents:binding': {
        spec: {
          allowedSecrets: ['github-token'],
          subjects: [{ kind: 'Agent', name: 'builder', namespace: 'agents' }],
        },
      },
    })

    await expect(
      validatePolicies(
        'agents',
        {
          approvalPolicies: ['approved'],
          budgetRef: 'budget',
          secretBindingRef: 'binding',
          requiredSecrets: ['github-token'],
          subject: { kind: 'Agent', name: 'builder', namespace: 'agents' },
        },
        getResource,
      ),
    ).resolves.toBeUndefined()
  })

  it('extracts runtime service account from either legacy or canonical config keys', () => {
    expect(extractRuntimeServiceAccount({ runtime: { config: { serviceAccount: 'legacy-sa' } } })).toBe('legacy-sa')
    expect(extractRuntimeServiceAccount({ runtime: { config: { serviceAccountName: 'canonical-sa' } } })).toBe(
      'canonical-sa',
    )
  })

  it('resolves effective service accounts with runtime, provider, and controller precedence', () => {
    const provider = { spec: { workload: { serviceAccountName: 'provider-sa' } } }

    expect(
      resolveEffectiveServiceAccount(
        { runtime: { config: { serviceAccountName: 'runtime-sa' } } },
        provider,
        'default-sa',
      ),
    ).toBe('runtime-sa')
    expect(resolveEffectiveServiceAccount({ runtime: { config: {} } }, provider, 'default-sa')).toBe('provider-sa')
    expect(resolveEffectiveServiceAccount({ runtime: { config: {} } }, null, 'default-sa')).toBe('default-sa')
    expect(resolveEffectiveServiceAccount({ runtime: { config: {} } }, null, null)).toBe('default')
    expect(extractProviderServiceAccount(provider)).toBe('provider-sa')
  })

  it('normalizes implementation source provider policy inputs', () => {
    expect(
      extractAllowedImplementationSourceProviders({
        security: { allowedImplementationSourceProviders: [' Linear ', 'GITHUB'] },
      }),
    ).toEqual(['linear', 'github'])
    expect(extractImplementationSourceProvider({ source: { provider: ' Linear ' } })).toBe('linear')
    expect(extractImplementationSourceProvider({})).toBeNull()
  })
})
