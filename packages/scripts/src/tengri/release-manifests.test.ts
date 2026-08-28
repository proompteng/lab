import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readTengriRelease,
  TENGRI_GRPC_ENDPOINT,
  updateTengriRelease,
  validateTengriRelease,
  ZERO_DIGEST,
} from './release-manifests'

const tengriDigest = `sha256:${'a'.repeat(64)}`
const nanoagentDigest = `sha256:${'b'.repeat(64)}`

function fixture(tengri = ZERO_DIGEST, nanoagent = ZERO_DIGEST, enabled = false, bffEnabled = enabled) {
  const directory = mkdtempSync(join(tmpdir(), 'tengri-release-'))
  const kustomizationPath = join(directory, 'kustomization.yaml')
  const applicationSetPath = join(directory, 'platform.yaml')
  const bffDeploymentPath = join(directory, 'deployment.yaml')
  const tengriDeploymentPath = join(directory, 'tengri-deployment.yaml')
  writeFileSync(
    kustomizationPath,
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
configMapGenerator:
  - name: tengri-release
    literals:
      - NANOAGENT_IMAGE=registry.ide-newton.ts.net/lab/nanoagent@${nanoagent}
images:
  - name: registry.ide-newton.ts.net/lab/tengri
    newName: registry.ide-newton.ts.net/lab/tengri
    digest: ${tengri}
`,
  )
  writeFileSync(
    applicationSetPath,
    `spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
              - name: kata
                enabled: "true"
              - name: tengri
                path: argocd/applications/tengri
                namespace: tengri
                automation: auto
                enabled: "${enabled}"
                managedNamespaceMetadata:
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
              - name: cdi
                enabled: "true"
`,
  )
  writeFileSync(
    bffDeploymentPath,
    `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: proompteng
          env:
            - name: TENGRI_GRPC_ENDPOINT
              value: ${bffEnabled ? TENGRI_GRPC_ENDPOINT : '""'}
`,
  )
  writeFileSync(
    tengriDeploymentPath,
    `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: tengri
          image: registry.ide-newton.ts.net/lab/tengri
`,
  )
  return { directory, kustomizationPath, applicationSetPath, bffDeploymentPath, tengriDeploymentPath }
}

describe('Tengri release manifests', () => {
  it('accepts the disabled all-zero bootstrap state', () => {
    const paths = fixture()
    expect(validateTengriRelease(paths)).toEqual({
      tengriDigest: ZERO_DIGEST,
      nanoagentDigest: ZERO_DIGEST,
      enabled: false,
      bffEnabled: false,
    })
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('updates both digests and enables the application in one operation', () => {
    const paths = fixture()
    expect(updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toEqual({
      tengriDigest,
      nanoagentDigest,
      enabled: true,
      bffEnabled: true,
    })
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toContain('enabled: "true"')
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toContain(TENGRI_GRPC_ENDPOINT)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects enabled placeholders and partial bootstrap state', () => {
    const enabledPlaceholders = fixture(ZERO_DIGEST, ZERO_DIGEST, true)
    expect(() => validateTengriRelease(enabledPlaceholders)).toThrow('cannot reference a bootstrap zero digest')
    rmSync(enabledPlaceholders.directory, { recursive: true, force: true })

    const partial = fixture(tengriDigest, ZERO_DIGEST, false)
    expect(() => validateTengriRelease(partial)).toThrow('must keep both images at the bootstrap zero digest')
    rmSync(partial.directory, { recursive: true, force: true })

    const disabledPublishedRelease = fixture(tengriDigest, nanoagentDigest, false)
    expect(() => validateTengriRelease(disabledPublishedRelease)).toThrow(
      'must keep both images at the bootstrap zero digest',
    )
    rmSync(disabledPublishedRelease.directory, { recursive: true, force: true })

    const enabledWithoutBff = fixture(tengriDigest, nanoagentDigest, true, false)
    expect(() => validateTengriRelease(enabledWithoutBff)).toThrow('must be enabled or disabled together')
    rmSync(enabledWithoutBff.directory, { recursive: true, force: true })

    const disabledWithBff = fixture(ZERO_DIGEST, ZERO_DIGEST, false, true)
    expect(() => validateTengriRelease(disabledWithBff)).toThrow('must be enabled or disabled together')
    rmSync(disabledWithBff.directory, { recursive: true, force: true })
  })

  it('rejects malformed and zero release inputs without mutating files', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    expect(() => updateTengriRelease({ tengriDigest: 'sha256:bad', nanoagentDigest }, paths)).toThrow('must match')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest: ZERO_DIGEST }, paths)).toThrow('cannot be')
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(beforeApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('reads only the Tengri ApplicationSet entry', () => {
    const paths = fixture(tengriDigest, nanoagentDigest, true)
    expect(readTengriRelease(paths).enabled).toBe(true)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects a base Deployment image that the verified digest selector cannot replace', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.tengriDeploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: tengri
          image: registry.ide-newton.ts.net/lab/unverified
`,
    )

    expect(() => validateTengriRelease(paths)).toThrow('Tengri Deployment image must be')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'Tengri Deployment image must be',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(beforeApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })
})
