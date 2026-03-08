import { describe, expect, it, vi } from 'vitest'

import { checkCrds, resolveKubernetesServiceReferenceFromUrl } from '~/server/agents-controller/controller-config'

const checkedAt = '2026-03-08T00:00:00.000Z'
const requiredCrds = ['agentruns.agents.proompteng.ai']

const createKubectlMock = (responses: Record<string, { stdout?: string; stderr?: string; code: number }>) =>
  vi.fn(async (args: string[]) => {
    const key = args.join(' ')
    const response = responses[key]
    if (!response) {
      throw new Error(`unexpected kubectl invocation: ${key}`)
    }
    return {
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      code: response.code,
    }
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
    const kubectl = createKubectlMock({
      'get crd -o jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}': {
        code: 0,
        stdout: `${requiredCrds[0]}\n`,
      },
    })

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: false,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      runKubectlCommand: kubectl,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubectl).toHaveBeenCalledTimes(1)
  })

  it('checks the configured cluster-local NATS service when agent comms are enabled', async () => {
    const kubectl = createKubectlMock({
      'get crd -o jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}': {
        code: 0,
        stdout: `${requiredCrds[0]}\n`,
      },
      'get svc -n nats nats -o name': {
        code: 0,
        stdout: 'service/nats',
      },
    })

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      runKubectlCommand: kubectl,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubectl).toHaveBeenCalledTimes(2)
    expect(kubectl).toHaveBeenNthCalledWith(2, ['get', 'svc', '-n', 'nats', 'nats', '-o', 'name'])
  })

  it('skips Kubernetes service checks for external NATS endpoints', async () => {
    const kubectl = createKubectlMock({
      'get crd -o jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}': {
        code: 0,
        stdout: `${requiredCrds[0]}\n`,
      },
    })

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://broker.example.com:4222',
      }),
      runKubectlCommand: kubectl,
    })

    expect(result).toEqual({
      ok: true,
      missing: [],
      checkedAt,
    })
    expect(kubectl).toHaveBeenCalledTimes(1)
  })

  it('reports the configured NATS service when the service lookup fails', async () => {
    const kubectl = createKubectlMock({
      'get crd -o jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}': {
        code: 0,
        stdout: `${requiredCrds[0]}\n`,
      },
      'get svc -n nats nats -o name': {
        code: 1,
        stderr: 'Error from server (NotFound): services "nats" not found',
      },
    })

    const result = await checkCrds({
      ...baseOptions,
      resolveNatsDependency: () => ({
        enabled: true,
        url: 'nats://nats.nats.svc.cluster.local:4222',
      }),
      runKubectlCommand: kubectl,
    })

    expect(result).toEqual({
      ok: false,
      missing: ['service:nats@nats'],
      checkedAt,
    })
  })
})
