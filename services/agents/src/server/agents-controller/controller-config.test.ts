import { describe, expect, it, vi } from 'vitest'

import { checkCrds, resolveKubernetesServiceReferenceFromUrl } from '~/server/agents-controller/controller-config'
import type { KubeGateway } from '~/server/kube-gateway'

const checkedAt = '2026-03-08T00:00:00.000Z'
const requiredCrds = ['agentruns.agents.proompteng.ai']

const createKubeGatewayMock = (
  overrides: Partial<Pick<KubeGateway, 'listCustomResourceDefinitions' | 'serviceExists'>> = {},
): Pick<KubeGateway, 'listCustomResourceDefinitions' | 'serviceExists'> => ({
  listCustomResourceDefinitions: vi.fn(async () => requiredCrds),
  serviceExists: vi.fn(async () => true),
  ...overrides,
})

describe('resolveKubernetesServiceReferenceFromUrl', () => {
  it('uses the fallback namespace for single-segment service hosts', () => {
    expect(resolveKubernetesServiceReferenceFromUrl('nats://nats:4222', 'agents-ci')).toEqual({
      name: 'nats',
      namespace: 'agents-ci',
    })
  })

  it('uses the namespace embedded in short service.namespace hosts', () => {
    expect(resolveKubernetesServiceReferenceFromUrl('nats://nats.nats:4222', 'agents-ci')).toEqual({
      name: 'nats',
      namespace: 'nats',
    })
  })

  it('uses the namespace embedded in service.namespace.svc hosts', () => {
    expect(resolveKubernetesServiceReferenceFromUrl('nats://nats.nats.svc.cluster.local:4222', 'agents-ci')).toEqual({
      name: 'nats',
      namespace: 'nats',
    })
  })

  it('skips external hosts that are not cluster-local service names', () => {
    expect(resolveKubernetesServiceReferenceFromUrl('nats://broker.example.com:4222', 'agents-ci')).toBeNull()
  })

  it('skips invalid URLs', () => {
    expect(resolveKubernetesServiceReferenceFromUrl('not a url', 'agents-ci')).toBeNull()
  })
})

describe('checkCrds', () => {
  const baseOptions = {
    resolveRequiredCrds: () => requiredCrds,
    resolveCrdCheckNamespace: () => 'agents-ci',
    nowIso: () => checkedAt,
  }

  it('skips the NATS service lookup when agent comms are disabled', async () => {
    const kubeGateway = createKubeGatewayMock()

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: false,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      kubeGateway,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubeGateway.listCustomResourceDefinitions).toHaveBeenCalledTimes(1)
    expect(kubeGateway.serviceExists).not.toHaveBeenCalled()
  })

  it('checks the configured cluster-local NATS service when agent comms are enabled', async () => {
    const kubeGateway = createKubeGatewayMock()

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      kubeGateway,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubeGateway.serviceExists).toHaveBeenCalledTimes(1)
    expect(kubeGateway.serviceExists).toHaveBeenCalledWith('nats', 'nats')
  })

  it('skips Kubernetes service checks for external NATS endpoints', async () => {
    const kubeGateway = createKubeGatewayMock()

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://broker.example.com:4222',
      }),
      kubeGateway,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubeGateway.serviceExists).not.toHaveBeenCalled()
  })

  it('reports the configured NATS service when the service lookup fails', async () => {
    const kubeGateway = createKubeGatewayMock({
      serviceExists: vi.fn(async () => false),
    })

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      kubeGateway,
    })

    expect(result).toEqual({
      ok: false,
      missing: ['service:nats@nats'],
      checkedAt,
    })
  })
})
