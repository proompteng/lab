import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'
import { __private } from '../deploy-service'

const baseManifest = `---
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: froussard
spec:
  template:
    spec:
      containers:
        - name: app
          image: registry.ide-newton.ts.net/lab/froussard@sha256:old
          env:
            - name: FROUSSARD_VERSION
              value: old-version
            - name: FROUSSARD_COMMIT
              value: old-commit
            - name: OTHER_ENV
              value: keep-me
`

describe('froussard deploy-service helpers', () => {
  it('updates the Knative manifest with new image digest and metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'froussard-deploy-test-'))
    const manifestPath = join(dir, 'service.yaml')
    writeFileSync(manifestPath, baseManifest, 'utf8')

    const relativePath = relative(repoRoot, manifestPath)

    await __private.updateKnativeServiceManifest({
      manifestPath: relativePath,
      imageDigest: 'registry.ide-newton.ts.net/lab/froussard@sha256:feedface',
      version: 'v1.2.3',
      commit: 'abc123',
    })

    const parsed = YAML.parse(readFileSync(manifestPath, 'utf8'))
    const container = parsed.spec.template.spec.containers[0]
    expect(container.image).toBe('registry.ide-newton.ts.net/lab/froussard@sha256:feedface')

    const versionEnv = container.env.find((entry: { name: string }) => entry.name === 'FROUSSARD_VERSION')
    expect(versionEnv?.value).toBe('v1.2.3')

    const commitEnv = container.env.find((entry: { name: string }) => entry.name === 'FROUSSARD_COMMIT')
    expect(commitEnv?.value).toBe('abc123')

    const otherEnv = container.env.find((entry: { name: string }) => entry.name === 'OTHER_ENV')
    expect(otherEnv?.value).toBe('keep-me')

    rmSync(dir, { recursive: true, force: true })
  })
})
