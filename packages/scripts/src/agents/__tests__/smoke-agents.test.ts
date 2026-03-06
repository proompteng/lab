import { describe, expect, it } from 'bun:test'

import { buildHelmArgs } from '../smoke-agents'

describe('buildHelmArgs', () => {
  it('applies image repository, tag, and empty digest overrides', () => {
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents-ci',
      valuesFile: '/workspace/lab/charts/agents/values-ci.yaml',
      createNamespace: true,
      databaseUrl: 'postgresql://agents:pw@agents-postgres:5432/agents?sslmode=disable',
      imageRepository: 'ghcr.io/proompteng/jangar',
      imageTag: 'latest',
      imageDigestSet: true,
      imageDigest: '',
    })

    expect(args).toEqual([
      'upgrade',
      '--install',
      'agents',
      '/workspace/lab/charts/agents',
      '--namespace',
      'agents-ci',
      '--values',
      '/workspace/lab/charts/agents/values-ci.yaml',
      '--create-namespace',
      '--set-string',
      'database.url=postgresql://agents:pw@agents-postgres:5432/agents?sslmode=disable',
      '--set',
      'image.repository=ghcr.io/proompteng/jangar',
      '--set',
      'image.tag=latest',
      '--set',
      'image.digest=',
    ])
  })

  it('omits image digest when the env key is unset', () => {
    const args = buildHelmArgs({
      releaseName: 'agents',
      namespace: 'agents',
      valuesFile: '/workspace/lab/charts/agents/values-local.yaml',
      createNamespace: false,
      imageDigestSet: false,
      imageDigest: '',
    })

    expect(args).not.toContain('image.digest=')
    expect(args).not.toContain('--create-namespace')
  })
})
