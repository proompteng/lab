import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { assertValidSourceSha, extractSourceShaFromManifest, readSourceShaFromManifest } from '../source-ci'

describe('torghut source-ci', () => {
  it('extracts TORGHUT_COMMIT from a structured manifest env entry', () => {
    const manifest = `apiVersion: serving.knative.dev/v1
kind: Service
spec:
  template:
    spec:
      containers:
        - name: user-container
          env:
            - name: TORGHUT_VERSION
              value: v0.568.5
            - name: TORGHUT_COMMIT
              value: 1234567890abcdef1234567890abcdef12345678
`

    expect(extractSourceShaFromManifest(manifest)).toBe('1234567890abcdef1234567890abcdef12345678')
  })

  it('extracts a custom commit env name from nested multi-document manifests', () => {
    const manifest = `apiVersion: v1
kind: ConfigMap
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: bootstrap
          env:
            - name: TORGHUT_OPTIONS_COMMIT
              value: abcdefabcdefabcdefabcdefabcdefabcdefabcd
`

    expect(extractSourceShaFromManifest(manifest, 'TORGHUT_OPTIONS_COMMIT')).toBe(
      'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    )
  })

  it('rejects missing, empty, and malformed source shas', () => {
    expect(() => assertValidSourceSha('not-a-sha')).toThrow("Invalid Torghut source SHA 'not-a-sha'")
    expect(() => extractSourceShaFromManifest('kind: Service\n')).toThrow('TORGHUT_COMMIT was not found in manifest')
    expect(() =>
      extractSourceShaFromManifest(`kind: Service
spec:
  template:
    spec:
      containers:
        - env:
            - name: TORGHUT_COMMIT
              value: ""
`),
    ).toThrow('TORGHUT_COMMIT is present but empty')
  })

  it('reads relative manifest paths from the repository root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-source-ci-'))
    const manifestPath = join(dir, 'service.yaml')
    writeFileSync(
      manifestPath,
      `kind: Service
spec:
  template:
    spec:
      containers:
        - env:
            - name: TORGHUT_COMMIT
              value: fedcba9876543210fedcba9876543210fedcba98
`,
      'utf8',
    )

    expect(readSourceShaFromManifest(relative(repoRoot, manifestPath))).toBe('fedcba9876543210fedcba9876543210fedcba98')

    rmSync(dir, { recursive: true, force: true })
  })
})
