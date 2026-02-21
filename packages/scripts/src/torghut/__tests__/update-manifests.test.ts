import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-manifests'

const createFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'torghut-manifests-test-'))
  const manifestPath = join(dir, 'knative-service.yaml')
  writeFileSync(
    manifestPath,
    `apiVersion: serving.knative.dev/v1
kind: Service
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
  return { dir, manifestPath }
}

describe('update-manifests', () => {
  it('updates image digest, rollout timestamp, and metadata env values', () => {
    const fixture = createFixture()
    const result = __private.updateTorghutManifest({
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      version: 'v0.600.0',
      commit: '1234567890abcdef1234567890abcdef12345678',
      rolloutTimestamp: '2026-02-21T04:00:00Z',
      manifestPath: relative(repoRoot, fixture.manifestPath),
    })

    const manifest = readFileSync(fixture.manifestPath, 'utf8')
    expect(manifest).toContain('client.knative.dev/updateTimestamp: "2026-02-21T04:00:00Z"')
    expect(manifest).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(manifest).toContain('value: v0.600.0')
    expect(manifest).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(result.changed).toBe(true)
    expect(result.imageRef).toBe(
      'registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )

    rmSync(fixture.dir, { recursive: true, force: true })
  })

  it('returns changed=false when manifest already matches requested state', () => {
    const fixture = createFixture()
    const options = {
      imageName: 'registry.ide-newton.ts.net/lab/torghut',
      digest: 'sha256:ef4a4f754c30705019667f7aa6c89ca95b8ca4f2f1539ca0f8ce62d56a4be63c',
      version: 'v0.601.0',
      commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      rolloutTimestamp: '2026-02-21T05:00:00Z',
      manifestPath: relative(repoRoot, fixture.manifestPath),
    }

    __private.updateTorghutManifest(options)
    const second = __private.updateTorghutManifest(options)
    expect(second.changed).toBe(false)

    rmSync(fixture.dir, { recursive: true, force: true })
  })
})
