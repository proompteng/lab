import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const deployment = readRepoFile('argocd/applications/registry/deployment.yaml')
const haproxyConfig = readRepoFile('argocd/applications/registry/haproxy.cfg')
const kustomization = readRepoFile('argocd/applications/registry/kustomization.yaml')
const pvc = readRepoFile('argocd/applications/registry/pvc.yaml')
const service = readRepoFile('argocd/applications/registry/service.yaml')

const backendBlock = (name: string): string => {
  const marker = `\nbackend ${name}\n`
  const start = haproxyConfig.indexOf(marker)
  expect(start).toBeGreaterThan(-1)

  const contentStart = start + 1
  const next = haproxyConfig.indexOf('\nbackend ', contentStart + marker.length)
  return haproxyConfig.slice(contentStart, next === -1 ? haproxyConfig.length : next)
}

describe('private registry write-pressure boundary', () => {
  it('rate-limits every registry mutation through one shared backend connection', () => {
    expect(haproxyConfig).toContain('filter bwlim-in registry_upload default-limit 1m default-period 1s')
    expect(haproxyConfig).toContain('acl write_request method POST PUT PATCH DELETE')
    expect(haproxyConfig).toContain('http-request set-bandwidth-limit registry_upload if write_request')
    expect(haproxyConfig).toContain('use_backend registry_write if write_request')
    expect(haproxyConfig).toContain('default_backend registry_read')

    const writeBackend = backendBlock('registry_write')
    expect(writeBackend).toContain('option http-server-close')
    expect(writeBackend).toContain('127.0.0.1:5000 maxconn 1 maxqueue 128 check')
  })

  it('keeps image pulls concurrent and separate from the write queue', () => {
    expect(haproxyConfig).not.toContain('http-request set-bandwidth-limit registry_upload unless write_request')

    const readBackend = backendBlock('registry_read')
    expect(readBackend).toContain('127.0.0.1:5000 maxconn 100 check')
    expect(readBackend).not.toContain('maxconn 1 ')
    expect(readBackend).not.toContain('set-bandwidth-limit')
  })

  it('serves traffic through the pinned non-root proxy and rolls config changes', () => {
    expect(service).toContain('targetPort: registry-http')
    expect(deployment).toContain('type: Recreate')
    expect(deployment).toContain(
      'haproxy:3.2.21-alpine@sha256:66e25cc9a8332635f4e897f7f4b1e5622c25f09f0ee23cddc6ce9bdb3a24772a',
    )
    expect(deployment).toContain('runAsNonRoot: true')
    expect(deployment).toContain('readOnlyRootFilesystem: true')
    expect(deployment).toContain('containerPort: 8080')
    expect(haproxyConfig).toContain('bind :8080')
    expect(deployment).toContain('path: /v2/')
    expect(kustomization).toContain('configMapGenerator:')
    expect(kustomization).toContain('haproxy.cfg=haproxy.cfg')
  })

  it('preserves the single Ceph filesystem store and its existing claim', () => {
    expect(deployment).toContain('claimName: registry-data')
    expect(pvc).toContain('storageClassName: rook-ceph-block')
    expect(pvc).toContain('storage: 2Ti')
  })
})
