import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-manifests'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'torghut-manifests-test-'))
  const serviceManifestPath = join(dir, 'knative-service.yaml')
  const migrationManifestPath = join(dir, 'db-migrations-job.yaml')
  writeFileSync(
    serviceManifestPath,
    `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
    serving.knative.dev/creator: system:serviceaccount:argocd:argocd-application-controller
    serving.knative.dev/lastModifier: admin
spec:
  template:
    metadata:
      annotations:
        client.knative.dev/updateTimestamp: "2025-01-01T00:00:00Z"
    spec:
      containers:
        - name: user-container
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_VERSION
              value: old-version
            - name: TORGHUT_COMMIT
              value: old-commit
`,
    'utf8',
  )
  writeFileSync(
    migrationManifestPath,
    `apiVersion: batch/v1
kind: Job
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
    'utf8',
  )
  return { dir, serviceManifestPath, migrationManifestPath }
}

describe('update-manifests', () => {
  it('updates service and migration image digest, rollout timestamp, and metadata env values', () => {
    const fixture = createFixture()
    const result = __private.updateTorghutManifests({
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      version: 'v0.600.0',
      commit: '1234567890abcdef1234567890abcdef12345678',
      rolloutTimestamp: '2026-02-21T04:00:00Z',
      manifestPath: relative(repoRoot, fixture.serviceManifestPath),
      migrationManifestPath: relative(repoRoot, fixture.migrationManifestPath),
    })

    const serviceManifest = readFileSync(fixture.serviceManifestPath, 'utf8')
    const migrationManifest = readFileSync(fixture.migrationManifestPath, 'utf8')
    expect(serviceManifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(serviceManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(serviceManifest).toContain(
      'serving.knative.dev/creator: system:serviceaccount:argocd:argocd-application-controller',
    )
    expect(serviceManifest).not.toContain('serving.knative.dev/lastModifier:')
    expect(serviceManifest).toContain('value: v0.600.0')
    expect(serviceManifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(migrationManifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(result.changed).toBe(true)
    expect(result.imageRef).toBe(
      'registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(result.changedPaths.length).toBe(2)

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('returns changed=false when manifests already match requested state', () => {
    const fixture = createFixture()
    const options = {
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:ef4a4f754c30705019667f7aa6c89ca95b8ca4f2f1539ca0f8ce62d56a4be63c',
      version: 'v0.601.0',
      commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rolloutTimestamp: '2026-02-21T05:00:00Z',
      manifestPath: relative(repoRoot, fixture.serviceManifestPath),
      migrationManifestPath: relative(repoRoot, fixture.migrationManifestPath),
    }

    __private.updateTorghutManifests(options)
    const second = __private.updateTorghutManifests(options)
    expect(second.changed).toBe(false)

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
