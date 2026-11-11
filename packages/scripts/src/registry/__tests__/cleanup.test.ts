import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isSeq, parseAllDocuments } from 'yaml'
import protectedResources from '../protected_resources.json'

test('registry cleanup preserves retained graphs and fails closed before deletion', () => {
  const path = fileURLToPath(new URL('../test_cleanup.py', import.meta.url))
  const result = Bun.spawnSync(['python3', path], { stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test('registry cleanup confirms the exact worker stopped before reopening uploads', () => {
  const path = fileURLToPath(new URL('../test_maintenance.py', import.meta.url))
  const result = Bun.spawnSync(['python3', path], { stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test('registry protection includes idle custom workloads and fails closed when an image-owner read fails', () => {
  const path = fileURLToPath(new URL('../test_protected_references.py', import.meta.url))
  const result = Bun.spawnSync(['python3', path], { stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test('registry cleanup grants only the named image-reference reads', () => {
  const path = new URL('../../../../../argocd/applications/registry/cleanup-rbac.yaml', import.meta.url)
  const documents = parseAllDocuments(readFileSync(path, 'utf8'))
  for (const document of documents) expect(document.errors).toEqual([])
  const role = documents.find((document) => document.get('kind') === 'ClusterRole')
  const rules = role?.get('rules')
  if (!isSeq(rules)) throw new Error('Missing registry cleanup reference permissions')
  expect(rules.toJSON()).toEqual(
    Object.entries(protectedResources).map(([group, resources]) => ({
      apiGroups: [group],
      resources,
      verbs: ['list'],
    })),
  )
  const argocdRole = documents.find(
    (document) => document.get('kind') === 'Role' && document.getIn(['metadata', 'namespace']) === 'argocd',
  )
  expect(argocdRole).toBeUndefined()
  const maintenanceRole = documents.find(
    (document) => document.get('kind') === 'Role' && document.getIn(['metadata', 'namespace']) === 'registry',
  )
  const maintenance = maintenanceRole?.get('rules')
  if (!isSeq(maintenance)) throw new Error('Missing namespaced Argo maintenance permissions')
  expect(maintenance.toJSON()).toEqual([
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
    { apiGroups: [''], resources: ['persistentvolumeclaims'], resourceNames: ['registry-data'], verbs: ['get'] },
  ])
})
