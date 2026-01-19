import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '~/server/primitives-kube'
import { validateApprovalPolicies, validateBudget, validateSecretBinding } from '~/server/primitives-policy'

const createKubeMock = (resources: Record<string, Record<string, unknown> | null>): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
  applyManifest: vi.fn(async () => ({})),
  applyStatus: vi.fn(async (resource) => resource),
  createManifest: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async (_resource, _name, _namespace, patch) => patch as Record<string, unknown>),
  get: vi.fn(async (resource, name, namespace) => resources[`${resource}:${namespace}:${name}`] ?? null),
  list: vi.fn(async () => ({ items: [] })),
})

describe('primitives policy', () => {
  it('rejects missing budget', async () => {
    const kube = createKubeMock({})
    await expect(validateBudget('jangar', 'missing-budget', kube)).rejects.toThrow('budget not found')
  })

  it('rejects missing approval policy', async () => {
    const kube = createKubeMock({})
    await expect(validateApprovalPolicies('jangar', ['missing-policy'], kube)).rejects.toThrow(
      'approval policies not found',
    )
  })

  it('rejects denied approval policy', async () => {
    const kube = createKubeMock({
      'approvalpolicies.approvals.proompteng.ai:jangar:policy-1': { status: { phase: 'Denied' } },
    })
    await expect(validateApprovalPolicies('jangar', ['policy-1'], kube)).rejects.toThrow('approval policy policy-1 is')
  })

  it('accepts ready approval policy', async () => {
    const kube = createKubeMock({
      'approvalpolicies.approvals.proompteng.ai:jangar:policy-2': { status: { phase: 'Approved' } },
    })
    await expect(validateApprovalPolicies('jangar', ['policy-2'], kube)).resolves.toBeUndefined()
  })

  it('rejects exceeded budget usage', async () => {
    const kube = createKubeMock({
      'budgets.budgets.proompteng.ai:jangar:budget-1': {
        spec: { limits: { tokens: 1000, dollars: 50 } },
        status: { used: { tokens: 1200, dollars: 60 } },
      },
    })
    await expect(validateBudget('jangar', 'budget-1', kube)).rejects.toThrow('budget budget-1 tokens exceeded')
  })

  it('accepts budget within limits', async () => {
    const kube = createKubeMock({
      'budgets.budgets.proompteng.ai:jangar:budget-2': {
        spec: { limits: { tokens: 1000, dollars: 50 } },
        status: { used: { tokens: 800, dollars: 40 } },
      },
    })
    await expect(validateBudget('jangar', 'budget-2', kube)).resolves.toBeUndefined()
  })

  it('validates secret binding subjects and secrets', async () => {
    const binding = {
      spec: {
        allowedSecrets: ['alpha', 'beta'],
        subjects: [{ kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' }],
      },
    }
    const kube = createKubeMock({
      'secretbindings.security.proompteng.ai:jangar:binding-1': binding,
    })

    await expect(
      validateSecretBinding(
        'jangar',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' },
        ['alpha'],
        kube,
      ),
    ).resolves.toBeUndefined()

    await expect(
      validateSecretBinding(
        'jangar',
        'binding-1',
        { kind: 'Agent', name: 'codex-implementation', namespace: 'jangar' },
        ['gamma'],
        kube,
      ),
    ).rejects.toThrow('missing secrets')
  })
})
