import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-ws-manifest'

describe('update-ws-manifest', () => {
  it('updates the options ws image and version metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-ws-manifest-test-'))
    const manifestPath = join(dir, 'deployment.yaml')
    writeFileSync(
      manifestPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: torghut-ws-options
          image: registry.ide-newton.ts.net/lab/torghut-ws@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_WS_VERSION
              value: old-version
            - name: TORGHUT_WS_COMMIT
              value: old-commit
`,
      'utf8',
    )

    const result = __private.updateWsManifest(
      'registry.ide-newton.ts.net/lab/torghut-ws',
      'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      'main-20260308',
      '1234567890abcdef1234567890abcdef12345678',
      relative(repoRoot, manifestPath),
    )

    const updated = readFileSync(manifestPath, 'utf8')
    expect(updated).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut-ws@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(updated).toContain('value: main-20260308')
    expect(updated).toContain('value: 1234567890abcdef1234567890abcdef12345678')
    expect(result.changed).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
