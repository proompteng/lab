import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { repoRoot } from '../shared/cli'
import { updateSymphonyManifests } from './update-manifests'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-deploy-test-'))
  const kustomizationPath = join(dir, 'kustomization.yaml')
  const deploymentPath = join(dir, 'deployment.yaml')

  writeFileSync(
    kustomizationPath,
    `images:
  - name: registry.ide-newton.ts.net/lab/symphony
    newName: registry.ide-newton.ts.net/lab/symphony
    newTag: "latest"
`,
    'utf8',
  )

  writeFileSync(
    deploymentPath,
    `metadata:
  annotations:
    kubectl.kubernetes.io/restartedAt: "2025-01-01T00:00:00.000Z"
`,
    'utf8',
  )

  return { dir, kustomizationPath, deploymentPath }
}

describe('updateSymphonyManifests', () => {
  it('updates all requested overlay manifests and rollout annotations', () => {
    const fixtureA = createFixture()
    const fixtureB = createFixture()

    const result = updateSymphonyManifests({
      imageName: 'registry.ide-newton.ts.net/lab/symphony',
      tag: 'ca7550d11',
      digest: 'registry.ide-newton.ts.net/lab/symphony@sha256:abc123',
      rolloutTimestamp: '2026-03-13T09:00:00.000Z',
      kustomizationPaths: [
        relative(repoRoot, fixtureA.kustomizationPath),
        relative(repoRoot, fixtureB.kustomizationPath),
      ],
      deploymentPaths: [relative(repoRoot, fixtureA.deploymentPath), relative(repoRoot, fixtureB.deploymentPath)],
    })

    const kustomizationA = readFileSync(fixtureA.kustomizationPath, 'utf8')
    const deploymentA = readFileSync(fixtureA.deploymentPath, 'utf8')
    const kustomizationB = readFileSync(fixtureB.kustomizationPath, 'utf8')
    const deploymentB = readFileSync(fixtureB.deploymentPath, 'utf8')

    expect(kustomizationA).toContain('newTag: "ca7550d11"')
    expect(kustomizationA).toContain('digest: sha256:abc123')
    expect(deploymentA).toContain('kubectl.kubernetes.io/restartedAt: "2026-03-13T09:00:00.000Z"')
    expect(kustomizationB).toContain('newTag: "ca7550d11"')
    expect(kustomizationB).toContain('digest: sha256:abc123')
    expect(deploymentB).toContain('kubectl.kubernetes.io/restartedAt: "2026-03-13T09:00:00.000Z"')
    expect(result.changed).toHaveLength(2)
    expect(result.changed.map((entry) => basename(entry.kustomizationPath))).toEqual([
      'kustomization.yaml',
      'kustomization.yaml',
    ])

    rmSync(fixtureA.dir, { recursive: true, force: true })
    rmSync(fixtureB.dir, { recursive: true, force: true })
  })
})
