import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../shared/cli'
import { updateSymphonyManifests } from './deploy-service'

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
  it('updates kustomization tags when newName is present and adds digest pinning', () => {
    const fixture = createFixture()

    updateSymphonyManifests({
      tag: 'ca7550d11',
      digest: 'registry.ide-newton.ts.net/lab/symphony@sha256:abc123',
      rolloutTimestamp: '2026-03-13T09:00:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      deploymentPath: relative(repoRoot, fixture.deploymentPath),
    })

    const kustomization = readFileSync(fixture.kustomizationPath, 'utf8')
    const deployment = readFileSync(fixture.deploymentPath, 'utf8')

    expect(kustomization).toContain('newTag: "ca7550d11"')
    expect(kustomization).toContain('digest: sha256:abc123')
    expect(deployment).toContain('kubectl.kubernetes.io/restartedAt: "2026-03-13T09:00:00.000Z"')

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
