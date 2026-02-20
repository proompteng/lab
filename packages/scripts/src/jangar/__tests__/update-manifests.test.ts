import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { updateJangarManifests } from '../update-manifests'

const imageName = 'registry.ide-newton.ts.net/lab/jangar'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jangar-manifests-test-'))
  const kustomizationPath = join(dir, 'kustomization.yaml')
  const serviceManifestPath = join(dir, 'deployment.yaml')
  const workerManifestPath = join(dir, 'worker-deployment.yaml')

  writeFileSync(
    kustomizationPath,
    `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "old-tag"
    digest: sha256:old
`,
    'utf8',
  )
  writeFileSync(
    serviceManifestPath,
    `metadata:
  annotations:
    deploy.knative.dev/rollout: "2025-01-01T00:00:00.000Z"
`,
    'utf8',
  )
  writeFileSync(
    workerManifestPath,
    `metadata:
  annotations:
    kubectl.kubernetes.io/restartedAt: "2025-01-01T00:00:00.000Z"
`,
    'utf8',
  )

  return { dir, kustomizationPath, serviceManifestPath, workerManifestPath }
}

describe('updateJangarManifests', () => {
  it('updates tag, digest, and rollout annotations', () => {
    const fixture = createFixture()
    const rolloutTimestamp = '2026-02-20T06:30:00.000Z'

    const result = updateJangarManifests({
      imageName,
      tag: 'new-tag',
      digest: 'sha256:newdigest',
      rolloutTimestamp,
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      workerManifestPath: relative(repoRoot, fixture.workerManifestPath),
    })

    const kustomization = readFileSync(fixture.kustomizationPath, 'utf8')
    const serviceManifest = readFileSync(fixture.serviceManifestPath, 'utf8')
    const workerManifest = readFileSync(fixture.workerManifestPath, 'utf8')

    expect(kustomization).toContain('newTag: "new-tag"')
    expect(kustomization).toContain('digest: sha256:newdigest')
    expect(serviceManifest).toContain(`deploy.knative.dev/rollout: "${rolloutTimestamp}"`)
    expect(workerManifest).toContain(`kubectl.kubernetes.io/restartedAt: "${rolloutTimestamp}"`)
    expect(result.changed).toEqual({
      kustomization: true,
      service: true,
      worker: true,
    })

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('inserts digest when digest field is missing and normalizes repo digests', () => {
    const fixture = createFixture()
    const kustomizationWithoutDigest = `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "old-tag"
`
    writeFileSync(fixture.kustomizationPath, kustomizationWithoutDigest, 'utf8')

    updateJangarManifests({
      imageName,
      tag: 'digest-add',
      digest: 'registry.ide-newton.ts.net/lab/jangar@sha256:abc123',
      rolloutTimestamp: '2026-02-20T07:00:00.000Z',
      kustomizationPath: relative(repoRoot, fixture.kustomizationPath),
      serviceManifestPath: relative(repoRoot, fixture.serviceManifestPath),
      workerManifestPath: relative(repoRoot, fixture.workerManifestPath),
    })

    const kustomization = readFileSync(fixture.kustomizationPath, 'utf8')
    expect(kustomization).toContain('newTag: "digest-add"')
    expect(kustomization).toContain('digest: sha256:abc123')

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
