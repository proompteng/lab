import { describe, expect, it, vi } from 'vitest'

import {
  extractRuntimeServiceAccount,
  validateApprovalPolicies,
  validateBudget,
  validateSecretBinding,
} from '~/server/primitives-policy'

const createResourceGetter = (resources: Record<string, Record<string, unknown> | null>) =>
  vi.fn(async (kind: string, name: string, namespace: string) => resources[`${kind}:${namespace}:${name}`] ?? null)

describe('primitives policy', () => {
  it('rejects missing budget', async () => {
    const getResource = createResourceGetter({})
    await expect(validateBudget('jangar', 'missing-budget', getResource)).rejects.toThrow('budget not found')
    expect(getResource).toHaveBeenCalledWith('Budget', 'missing-budget', 'jangar')
  })

  it('rejects missing approval policy', async () => {
    const getResource = createResourceGetter({})
    await expect(validateApprovalPolicies('jangar', ['missing-policy'], getResource)).rejects.toThrow(
      'approval policies not found',
    )
    expect(getResource).toHaveBeenCalledWith('ApprovalPolicy', 'missing-policy', 'jangar')
  })

  it('rejects denied approval policy', async () => {
    const getResource = createResourceGetter({
      'ApprovalPolicy:jangar:policy-1': { status: { phase: 'Denied' } },
    })
    await expect(validateApprovalPolicies('jangar', ['policy-1'], getResource)).rejects.toThrow(
      'approval policy policy-1 is',
    )
  })

  it('accepts ready approval policy', async () => {
    const getResource = createResourceGetter({
      'ApprovalPolicy:jangar:policy-2': { status: { phase: 'Approved' } },
    })
    await expect(validateApprovalPolicies('jangar', ['policy-2'], getResource)).resolves.toBeUndefined()
  })

  it('rejects exceeded budget usage', async () => {
    const getResource = createResourceGetter({
      'Budget:jangar:budget-1': {
        spec: { limits: { tokens: 1000, dollars: 50 } },
        status: { used: { tokens: 1200, dollars: 60 } },
      },
    })
    await expect(validateBudget('jangar', 'budget-1', getResource)).rejects.toThrow('budget budget-1 tokens exceeded')
  })

  it('accepts budget within limits', async () => {
    const getResource = createResourceGetter({
      'Budget:jangar:budget-2': {
        spec: { limits: { tokens: 1000, dollars: 50 } },
        status: { used: { tokens: 800, dollars: 40 } },
      },
    })
    await expect(validateBudget('jangar', 'budget-2', getResource)).resolves.toBeUndefined()
  })

  it('validates secret binding subjects and secrets', async () => {
    const binding = {
      spec: {
        allowedSecrets: ['alpha', 'beta'],
        subjects: [{ kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' }],
      },
    }
    const getResource = createResourceGetter({
      'SecretBinding:jangar:binding-1': binding,
    })

    await expect(
      validateSecretBinding(
        'jangar',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' },
        ['alpha'],
        getResource,
      ),
    ).resolves.toBeUndefined()

    await expect(
      validateSecretBinding(
        'jangar',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' },
        ['gamma'],
        getResource,
      ),
    ).rejects.toThrow('missing secrets')
  })

  it('extracts runtime service account from either legacy or canonical config keys', () => {
    expect(extractRuntimeServiceAccount({ runtime: { config: { serviceAccount: 'legacy-sa' } } })).toBe('legacy-sa')
    expect(extractRuntimeServiceAccount({ runtime: { config: { serviceAccountName: 'canonical-sa' } } })).toBe(
      'canonical-sa',
    )
  })
})
