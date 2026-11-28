import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { expect, test } from 'bun:test'
import { isScalar, isSeq, parseAllDocuments } from 'yaml'

import { repoRoot } from '../../shared/cli'
import { loadEnabledAppInventory } from '../../shared/enabled-apps'

const applicationsDir = join(repoRoot, 'argocd/applications')
// These applications were excluded from Wave 24K to avoid overlapping changes.
const excludedApps = new Set([
  'agents',
  'bayn',
  'tailscale',
  'cockroach-operator',
  'longhorn',
  'clickhouse-upgrade-acceptance',
  'rook-ceph',
])

const readDocuments = (path: string) => {
  const documents = parseAllDocuments(readFileSync(path, 'utf8'))
  for (const document of documents) {
    const error = document.errors[0]
    if (error) throw new Error(`${relative(repoRoot, path)}: ${error.code} at line ${error.linePos?.[0]?.line}`)
  }
  return documents
}

// Follow local resource inputs from enabled applications, not unreferenced files, patches, or chart output.
const collectResourceFiles = (roots: string[]): Set<string> => {
  const files = new Set<string>()
  const visited = new Set<string>()
  const visit = (path: string) => {
    if (!path.startsWith(`${applicationsDir}${sep}`) || visited.has(path)) return
    if (excludedApps.has(relative(applicationsDir, path).split(sep)[0])) return
    visited.add(path)

    if (statSync(path).isFile()) {
      files.add(path)
      return
    }
    const kustomization = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']
      .map((name) => join(path, name))
      .find(existsSync)
    if (!kustomization) {
      if (existsSync(join(path, 'Chart.yaml'))) return
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isFile() && /\.(ya?ml|json)$/.test(entry.name)) files.add(join(path, entry.name))
      }
      return
    }

    const [config] = readDocuments(kustomization)
    for (const field of ['resources', 'bases', 'components']) {
      const refs = config?.get(field)
      if (refs == null) continue
      if (!isSeq(refs)) throw new Error(`${relative(repoRoot, kustomization)}: ${field} must be a sequence`)
      for (const ref of refs.items) {
        if (!isScalar(ref) || typeof ref.value !== 'string') {
          throw new Error(`${relative(repoRoot, kustomization)}: ${field} entries must be paths`)
        }
        if (!/^(?:https?:\/\/|git::|github\.com\/)/.test(ref.value)) visit(resolve(path, ref.value))
      }
    }
  }

  for (const root of roots) visit(root)
  return files
}

test('active Deployment manifests declare an integer revisionHistoryLimit from 0 to 5', () => {
  const roots = loadEnabledAppInventory()
    .entries.filter((entry) => entry.class !== 'external-source')
    .map((entry) => resolve(repoRoot, entry.path))
  const violations: string[] = []
  let checked = 0

  for (const path of collectResourceFiles(roots)) {
    for (const document of readDocuments(path)) {
      if (document.get('kind') !== 'Deployment') continue
      checked++
      const limit: unknown = document.getIn(['spec', 'revisionHistoryLimit'])
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 5) {
        const name = document.getIn(['metadata', 'name'])
        violations.push(`${relative(repoRoot, path)} (Deployment/${typeof name === 'string' ? name : '<unnamed>'})`)
      }
    }
  }

  expect(checked).toBeGreaterThan(0)
  expect(violations.sort()).toEqual([])
})
