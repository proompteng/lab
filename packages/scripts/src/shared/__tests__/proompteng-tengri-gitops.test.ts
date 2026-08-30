import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readManifest = (path: string): Record<string, any> => YAML.parse(readFileSync(new URL(path, repoRoot), 'utf8'))

test('Proompteng isolates public BFF rate limits by Cloudflare client IP', () => {
  const resources = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/proompteng/ingressroute.yaml', repoRoot), 'utf8'),
  ).map((document) => document.toJSON() as Record<string, any>)
  const middleware = resources.find((resource) => resource.kind === 'Middleware')

  expect(middleware?.spec.rateLimit).toMatchObject({
    average: 240,
    burst: 240,
    period: '1m',
    sourceCriterion: { requestHeaderName: 'CF-Connecting-IP' },
  })
})

test('Proompteng keeps the Next.js runtime cache writable on a read-only root filesystem', () => {
  const deployment = readManifest('argocd/applications/proompteng/deployment.yaml')
  const podSpec = deployment.spec.template.spec
  const container = podSpec.containers.find((candidate: Record<string, any>) => candidate.name === 'proompteng')

  expect(container.securityContext.readOnlyRootFilesystem).toBe(true)
  expect(container.volumeMounts).toContainEqual({
    name: 'next-cache',
    mountPath: '/app/apps/landing/.next/cache',
  })
  expect(podSpec.volumes).toContainEqual({
    name: 'next-cache',
    emptyDir: { sizeLimit: '256Mi' },
  })
})
