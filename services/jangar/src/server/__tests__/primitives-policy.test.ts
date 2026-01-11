import { describe, expect, it, vi } from 'vitest'

import type { KubernetesClient } from '~/server/primitives-kube'
import { validateApprovalPolicies, validateBudget, validateSecretBinding } from '~/server/primitives-policy'

const createKubeMock = (resources: Record<string, Record<string, unknown> | null>): KubernetesClient => ({
  apply: vi.fn(async (resource) => resource),
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
