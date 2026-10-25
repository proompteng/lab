import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readManifest = (path: string): Record<string, any> => YAML.parse(readFileSync(new URL(path, repoRoot), 'utf8'))

test('Proompteng rate limits use connection peers without trusting supplied proxy headers', () => {
  const resources = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/proompteng/ingressroute.yaml', repoRoot), 'utf8'),
  ).map((document) => document.toJSON() as Record<string, any>)
  const middleware = resources.find((resource) => resource.kind === 'Middleware')

  expect(middleware?.spec.rateLimit).toMatchObject({
    average: 240,
    burst: 240,
    period: '1m',
  })
  for (const resource of resources.filter((candidate) => candidate.kind === 'Middleware')) {
    expect(resource.spec.rateLimit.sourceCriterion).toBeUndefined()
  }
})

test('Proompteng withholds Kargo discovery until the coordinated Tengri cutover is ready', () => {
  const workflow = readManifest('.github/workflows/product-nix-images.yml')
  expect(workflow.jobs['build-proompteng'].with.publish_kargo_tag).toBe(
    "${{ vars.TENGRI_PREPARED_SLOT_CUTOVER_READY == 'true' }}",
  )
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
