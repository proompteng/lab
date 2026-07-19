import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { updateBaynManifests } from './update-manifests'

let directory: string | undefined

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe('Bayn manifest promotion', () => {
  test('pins tag and digest and binds runtime evidence to the source commit', () => {
    directory = mkdtempSync(join(tmpdir(), 'bayn-manifest-'))
    const kustomizationPath = join(directory, 'kustomization.yaml')
    const deploymentPath = join(directory, 'deployment.yaml')
    writeFileSync(
      kustomizationPath,
      `images:\n  - name: registry.ide-newton.ts.net/lab/bayn\n    newName: registry.ide-newton.ts.net/lab/bayn\n    newTag: bootstrap\n`,
    )
    writeFileSync(
      deploymentPath,
      `metadata:\n  template:\n    metadata:\n      annotations:\n        kubectl.kubernetes.io/restartedAt: "old"\n    spec:\n      containers:\n        - env:\n            - name: BAYN_CODE_REVISION\n              value: bootstrap\n`,
    )
    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    updateBaynManifests({
      sourceSha,
      tag: `sha-${sourceSha}`,
      digest,
      rolloutTimestamp: '2026-07-19T10:00:00Z',
      kustomizationPath,
      deploymentPath,
    })
    expect(readFileSync(kustomizationPath, 'utf8')).toContain(`newTag: "sha-${sourceSha}"\n    digest: ${digest}`)
    expect(readFileSync(deploymentPath, 'utf8')).toContain(`value: ${sourceSha}`)
    expect(readFileSync(deploymentPath, 'utf8')).toContain('restartedAt: "2026-07-19T10:00:00Z"')
  })

  test('rejects malformed release metadata', () => {
    expect(() =>
      updateBaynManifests({
        sourceSha: 'main',
        tag: 'latest',
        digest: 'sha256:bad',
        rolloutTimestamp: 'now',
      }),
    ).toThrow('invalid source SHA')
  })
})
