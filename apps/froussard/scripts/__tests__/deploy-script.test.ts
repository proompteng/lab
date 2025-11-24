import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('deploy script', () => {
  const setEnv = (values: Record<string, string>) => {
    Object.assign(process.env, values)
  }

  const resetEnv = (keys: string[]) => {
    for (const key of keys) {
      delete process.env[key]
    }
  }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports sanitized manifest to filesystem after deploy', async () => {
    const exportPath = 'argocd/applications/froussard/knative-service.yaml'
    const kubeJson = JSON.stringify({
      metadata: {
        name: 'froussard',
        namespace: 'froussard',
        annotations: {
          'serving.knative.dev/revision-history-limit': '3',
          'serving.knative.dev/creator': 'system:admin',
          'serving.knative.dev/lastModifier': 'system:admin',
          'kubectl.kubernetes.io/last-applied-configuration': 'should be dropped',
        },
        labels: {
          foo: 'bar',
        },
      },
      spec: {
        template: {
          metadata: {
            annotations: {
              'autoscaling.knative.dev/min-scale': '1',
            },
            labels: {
              fizz: 'buzz',
            },
          },
          spec: {
            containerConcurrency: 0,
            timeoutSeconds: 300,
            enableServiceLinks: false,
            containers: [
              {
                name: 'user-container',
                image: 'registry.example.com/foo@sha256:abc',
                env: [
                  { name: 'BUILT', value: 'drop-me' },
                  { name: 'FOO', value: 'bar' },
                  { name: 'SECRET', valueFrom: { secretKeyRef: { name: 'secret', key: 'key' } } },
                ],
                readinessProbe: { httpGet: { path: '/ready', port: 0 } },
                livenessProbe: { httpGet: { path: '/live', port: 0 } },
                resources: {
                  limits: {},
                  requests: {
                    cpu: '',
                  },
                  claims: [{ name: 'cache' }, { name: '' }, null],
                },
              },
            ],
          },
        },
      },
    })

    const writeFileMock = vi.spyOn(await import('node:fs/promises'), 'writeFile').mockResolvedValue()
    const kubectlMock = vi.spyOn(await import('bun'), '$').mockReturnValue({
      text: vi.fn().mockResolvedValue(kubeJson),
    } as unknown as typeof import('bun')['$'])

    const bunMock = vi.fn().mockResolvedValue(undefined)
    const bunModule = await import('bun')
    const real$ = bunModule.$
    vi.spyOn(bunModule, '$', 'get').mockReturnValue(((...args: unknown[]) => {
      if (String(args[0]).includes('bun')) {
        return { text: bunMock } as unknown as ReturnType<typeof real$>
      }
      return kubectlMock(...args)
    }) as unknown as typeof real$)

    const version = 'v0.1.0'
    const commit = 'abc123'
    const envKeys = ['FROUSSARD_VERSION', 'FROUSSARD_COMMIT', 'FROUSSARD_KNATIVE_MANIFEST']
    setEnv({
      FROUSSARD_VERSION: version,
      FROUSSARD_COMMIT: commit,
      FROUSSARD_KNATIVE_MANIFEST: exportPath,
    })

    await import('../deploy')

    expect(bunMock).toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining(exportPath),
      expect.stringContaining('registry.example.com/foo@sha256:abc'),
    )

    const writtenYaml = writeFileMock.mock.calls[0][1] as string
    expect(writtenYaml).not.toContain('kubectl.kubernetes.io/last-applied-configuration')
    expect(writtenYaml).not.toContain('BUILT')
    expect(writtenYaml).toContain('name: SECRET')
    expect(writtenYaml).toContain('secretKeyRef')
    expect(writtenYaml).toContain(version)
    expect(writtenYaml).toContain(commit)
    expect(writtenYaml).toMatch(/^\s*resources:\s*\{\}/m)
    expect(writtenYaml).toMatch(/- name: FOO[\s\S]*- name: SECRET/)
    expect(writtenYaml).toMatch(/serving\.knative\.dev\/creator: system:admin/)
    expect(writtenYaml).toMatch(/serving\.knative\.dev\/lastModifier: system:admin/)
    expect(writtenYaml).toMatch(/argocd\.argoproj\.io\/compare-options: IgnoreExtraneous/)
    expect(writtenYaml).toMatch(
      /argocd\.argoproj\.io\/tracking-id: froussard:serving\.knative\.dev\/Service:froussard\/froussard/,
    )
    expect(writtenYaml).toMatch(/claims:\s*\n\s+- name: cache/)

    resetEnv(envKeys)
  })
})
