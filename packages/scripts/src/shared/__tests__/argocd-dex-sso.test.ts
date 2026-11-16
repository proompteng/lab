import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Argo CD Dex reads the static password hash from the sealed secret environment', () => {
  const config = readRepoFile('argocd/applications/argocd/overlays/argocd-cm.yaml')
  const deployment = readRepoFile('argocd/applications/argocd/overlays/argocd-dex-server-deployment.yaml')
  const secret = readRepoFile('argocd/applications/argocd/base/argo-workflows-sso-sealedsecret.yaml')

  expect(config).toContain('hashFromEnv: ARGO_WORKFLOWS_SSO_PASSWORD_HASH')
  expect(config).not.toMatch(/\bhash:\s*["']?\$2[aby]\$/)
  expect(deployment).toContain('name: ARGO_WORKFLOWS_SSO_PASSWORD_HASH')
  expect(deployment).toContain('key: hash')
  expect(secret).toMatch(/^\s+hash:\s+Ag/m)
})

test('Dex retains its existing memory storage and becomes ready only after its listener starts', () => {
  const config = YAML.parse(readRepoFile('argocd/applications/argocd/overlays/argocd-cm.yaml'))
  const dex = YAML.parse(config.data['dex.config'])
  expect(dex.storage).toEqual({ type: 'memory' })
  const deployment = YAML.parse(readRepoFile('argocd/applications/argocd/overlays/argocd-dex-server-deployment.yaml'))
  expect(deployment.spec.template.spec.containers[0].readinessProbe.tcpSocket.port).toBe(5556)
})
