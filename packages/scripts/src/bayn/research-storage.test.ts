import { existsSync, readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const manifests = (path: string) => YAML.parseAllDocuments(read(path)).map((document) => document.toJSON())
const storagePath = 'argocd/applications/rook-ceph/'

test('the retained account prototype keeps its existing protected identities', () => {
  const resources = manifests(`${storagePath}bayn-research-storage.yaml`)
  const account = resources.find((resource) => resource.kind === 'CephObjectStoreAccount')
  expect(account.spec).toEqual({ store: 'objectstore', rootUser: { displayName: 'bayn-research-owner' } })
  expect(account.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  const user = resources.find((resource) => resource.kind === 'CephObjectStoreUser')
  expect(user.spec).toEqual({
    store: 'objectstore',
    displayName: 'bayn-research-capture',
    accountRef: { name: 'bayn-research' },
    opMask: ['read', 'write'],
    quotas: { maxBuckets: -1 },
  })
})

test('the shared Rook resources retain credentials without a Bayn verification Job', () => {
  const resources = manifests(`${storagePath}bayn-research-storage.yaml`)
  expect(resources.filter((resource) => resource.kind === 'Job')).toEqual([])
  const generators = YAML.parse(read(`${storagePath}kustomization.yaml`)).configMapGenerator
  expect(generators.some((generator: { name: string }) => generator.name === 'bayn-research-storage-bootstrap')).toBe(
    false,
  )
  for (const obsolete of ['bayn-research-storage-bootstrap.sh', 'bayn-research-storage-policy.json']) {
    expect(existsSync(new URL(`${storagePath}${obsolete}`, root))).toBe(false)
  }
  const source = resources.filter((resource) => resource.kind === 'Secret')
  expect(source).toHaveLength(1)
  expect(source[0].metadata.name).toBe('rook-ceph-object-user-objectstore-bayn-research-capture')
  expect(source[0].metadata.annotations['reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces']).toBe('bayn')
  const bootstrap = YAML.parse(read('argocd/applicationsets/bootstrap.yaml'))
  const applications = bootstrap.spec.generators[0].matrix.generators[1].list.elements
  const rook = applications.find((application: { name: string }) => application.name === 'rook-ceph')
  expect(rook.ignoreDifferences).toContainEqual({
    kind: 'Secret',
    name: source[0].metadata.name,
    namespace: 'rook-ceph',
    jsonPointers: [
      '/data',
      '/metadata/labels',
      '/metadata/ownerReferences',
      '/metadata/annotations/argocd.argoproj.io~1tracking-id',
    ],
  })
})

test('native research storage uses a unique retained OBC with operator-owned reflected connection resources', () => {
  const source = manifests(`${storagePath}bayn-research-objectbucket.yaml`)
  expect(source.map((resource) => resource.kind)).toEqual(['ObjectBucketClaim', 'Secret', 'ConfigMap'])
  const claim = source[0]
  expect(claim.metadata.name).toBe('bayn-research-captures')
  expect(claim.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(claim.spec).toEqual({ generateBucketName: 'bayn-research-captures', storageClassName: 'rook-ceph-bucket' })
  const bootstrap = YAML.parse(read('argocd/applicationsets/bootstrap.yaml'))
  const applications = bootstrap.spec.generators[0].matrix.generators[1].list.elements
  const rook = applications.find((application: { name: string }) => application.name === 'rook-ceph')
  for (const resource of source.slice(1)) {
    expect(resource.metadata.name).toBe('bayn-research-captures')
    expect(resource.data).toBeUndefined()
    expect(resource.stringData).toBeUndefined()
    expect(resource.metadata.annotations['reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces']).toBe('bayn')
    expect(rook.ignoreDifferences).toContainEqual({
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: 'rook-ceph',
      jsonPointers: [
        '/data',
        '/metadata/labels',
        '/metadata/ownerReferences',
        '/metadata/annotations/argocd.argoproj.io~1tracking-id',
      ],
    })
  }
  const reflected = manifests('argocd/applications/bayn/research-objectbucket.yaml')
  expect(reflected.map((resource) => resource.kind)).toEqual(['Secret', 'ConfigMap'])
  for (const resource of reflected) {
    expect(resource.metadata.name).toBe('bayn-research-captures')
    expect(resource.metadata.annotations['reflector.v1.k8s.emberstack.com/reflects']).toBe(
      'rook-ceph/bayn-research-captures',
    )
    expect(resource.data).toBeUndefined()
    expect(resource.stringData).toBeUndefined()
  }
  expect(YAML.parse(read(`${storagePath}kustomization.yaml`)).resources).toContain('bayn-research-objectbucket.yaml')
  expect(YAML.parse(read('argocd/applications/bayn/kustomization.yaml')).resources).toContain(
    'research-objectbucket.yaml',
  )
})

test('retained research storage does not grant the trading worker bucket credentials or egress', () => {
  const resources = manifests('argocd/applications/bayn/research-storage.yaml')
  expect(resources.map((resource) => resource.kind)).toEqual(['Secret', 'ConfigMap'])
  const controller = YAML.parse(read('argocd/applications/bayn/execution-controller.yaml'))
  const containers = controller.spec.template.spec.containers
  for (const container of containers) {
    for (const env of container.env) {
      expect(env.name).not.toStartWith('BAYN_RESEARCH_CAPTURE_')
      expect(env.valueFrom?.secretKeyRef?.name).not.toBe('bayn-research-captures')
      expect(env.valueFrom?.secretKeyRef?.name).not.toBe('bayn-research-capture')
    }
  }
  const secret = resources.find((resource) => resource.kind === 'Secret')
  expect(secret.metadata.annotations['reflector.v1.k8s.emberstack.com/reflects']).toBe(
    'rook-ceph/rook-ceph-object-user-objectstore-bayn-research-capture',
  )
  expect(secret.data).toBeUndefined()
  expect(secret.stringData).toBeUndefined()
})
