import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-ta-manifest'

describe('update-ta-manifest', () => {
  it('updates the options ta image and version metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-ta-manifest-test-'))
    const manifestPath = join(dir, 'flinkdeployment.yaml')
    writeFileSync(
      manifestPath,
      `apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
spec:
  image: registry.ide-newton.ts.net/lab/torghut-ta@sha256:1111111111111111111111111111111111111111111111111111111111111111
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
    expect(result.changed).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
