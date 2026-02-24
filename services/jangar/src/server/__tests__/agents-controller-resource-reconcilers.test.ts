import { describe, expect, it, vi } from 'vitest'

import { createResourceReconcilers } from '~/server/agents-controller/resource-reconcilers'

const makeDeps = () => {
  const setStatus = vi.fn<
    (kube: unknown, resource: Record<string, unknown>, status: Record<string, unknown>) => Promise<void>
  >(async () => undefined)
  const deps = {
    setStatus,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    implementationTextLimit: 128 * 1024,
    resolveVcsAuthMethod: () => 'none',
    validateVcsAuthConfig: () => ({ ok: true as const, warnings: [] as Array<{ reason: string; message: string }> }),
    parseIntOrString: (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
      if (typeof value === 'string' && value.trim()) return value.trim()
      return null
    },
    secretHasKey: (secret: Record<string, unknown>, key: string) => {
      const data = (secret.data as Record<string, unknown> | undefined) ?? {}
      const stringData = (secret.stringData as Record<string, unknown> | undefined) ?? {}
      return key in data || key in stringData
    },
  }
  return { deps, setStatus }
}

describe('agents controller resource reconcilers module', () => {
  it('marks agent invalid when provider ref is missing', async () => {
    const { deps, setStatus } = makeDeps()
    const { reconcileAgent } = createResourceReconcilers(deps)

    await reconcileAgent(
      {
        get: vi.fn(),
      },
      { metadata: { generation: 1 }, spec: {} },
      'agents',
      [],
      [],
    )

    expect(setStatus).toHaveBeenCalledTimes(1)
    const [, , status] = setStatus.mock.calls[0]
    expect(status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'InvalidSpec', status: 'True', reason: 'MissingProviderRef' }),
      ]),
    )
  })

  it('marks implementation spec invalid when text is missing', async () => {
    const { deps, setStatus } = makeDeps()
    const { reconcileImplementationSpec } = createResourceReconcilers(deps)

    await reconcileImplementationSpec({ get: vi.fn() }, { metadata: { generation: 1 }, spec: {} })

    const [, , status] = setStatus.mock.calls[0]
    expect(status.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'InvalidSpec', status: 'True', reason: 'MissingText' })]),
    )
  })

  it('marks memory unreachable when backing secret is absent', async () => {
    const { deps, setStatus } = makeDeps()
    const { reconcileMemory } = createResourceReconcilers(deps)

    await reconcileMemory(
      {
        get: vi.fn(async () => null),
      },
      {
        metadata: { generation: 2 },
        spec: {
          type: 'custom',
          connection: {
            secretRef: {
              name: 'memory-secret',
              key: 'token',
            },
          },
        },
      },
      'agents',
    )

    const [, , status] = setStatus.mock.calls[0]
    expect(status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'Unreachable', status: 'True', reason: 'SecretNotFound' }),
      ]),
    )
  })
})
