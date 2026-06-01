import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-ta-manifest'

describe('update-ta-manifest', () => {
  const writeManifest = (manifestPath: string, restartNonce: number) => {
    writeFileSync(
      manifestPath,
      `apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
spec:
  image: registry.ide-newton.ts.net/lab/torghut-ta@sha256:1111111111111111111111111111111111111111111111111111111111111111
  restartNonce: ${restartNonce}
  podTemplate:
    spec:
      containers:
        - name: flink-main-container
          env:
            - name: TORGHUT_TA_VERSION
              value: old-version
            - name: TORGHUT_TA_COMMIT
              value: old-commit
`,
      'utf8',
    )
  }

  it('updates the ta image and version metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-ta-manifest-test-'))
    const manifestPath = join(dir, 'flinkdeployment.yaml')
    writeManifest(manifestPath, 8)

    const result = __private.updateTaManifest(
      'registry.ide-newton.ts.net/lab/torghut-ta',
      'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      'v0.600.0',
      '1234567890abcdef1234567890abcdef12345678',
      relative(repoRoot, manifestPath),
    )

    const updated = readFileSync(manifestPath, 'utf8')
    expect(updated).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut-ta@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(updated).toContain('value: v0.600.0')
    expect(updated).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(updated).toContain('restartNonce: 8')
    expect(result.changed).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it('updates multiple ta manifests and bumps restart nonces when requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-ta-manifest-test-'))
    const manifestPaths = ['ta.yaml', 'ta-sim.yaml', 'options-ta.yaml'].map((name, index) => {
      const manifestPath = join(dir, name)
      writeManifest(manifestPath, 7 + index)
      return manifestPath
    })

    const results = __private.updateTaManifests(
      'registry.ide-newton.ts.net/lab/torghut-ta',
      'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      '186840e5',
      '186840e512c0490414e253497bbebaaf5d9de29d',
      manifestPaths.map((manifestPath) => relative(repoRoot, manifestPath)),
      { bumpRestartNonce: true },
    )

    expect(results.every((result) => result.changed)).toBe(true)
    for (const [index, manifestPath] of manifestPaths.entries()) {
      const updated = readFileSync(manifestPath, 'utf8')
      expect(updated).toContain(
        'image: registry.ide-newton.ts.net/lab/torghut-ta@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      )
      expect(updated).toContain('value: 186840e5')
      expect(updated).toContain('value: 186840e512c0490414e253497bbebaaf5d9de29d')
      expect(updated).toContain(`restartNonce: ${8 + index}`)
    }

    rmSync(dir, { recursive: true, force: true })
  })

  it('parses repeated manifest paths and restart nonce flag', () => {
    const options = __private.parseArgs([
      '--manifest-path',
      'argocd/applications/torghut/ta/flinkdeployment.yaml',
      '--manifest-path=argocd/applications/torghut/ta-sim/flinkdeployment.yaml',
      '--bump-restart-nonce',
    ])

    expect(options.manifestPaths).toEqual([
      'argocd/applications/torghut/ta/flinkdeployment.yaml',
      'argocd/applications/torghut/ta-sim/flinkdeployment.yaml',
    ])
    expect(options.bumpRestartNonce).toBe(true)
  })
})
