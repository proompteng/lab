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
              - cluster: in-cluster
                suffix: ""
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
  template:
    spec:
      source:
        repoURL: '{{ if hasKey . "repoURL" }}{{ .repoURL }}{{ else }}https://github.com/proompteng/lab.git{{ end }}'
        targetRevision: '{{ if hasKey . "targetRevision" }}{{ .targetRevision }}{{ else }}main{{ end }}'
  templatePatch: |
    {{- if or $useLovely $hasKustomize }}
      source:
      {{- if $useLovely }}
        plugin:
          name: lovely
      {{- end }}
      {{- if $hasKustomize }}
        kustomize: {{ toJson .kustomize }}
      {{- end }}
    {{- end }}
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

  it('updates only the proompteng container endpoint', () => {
    const paths = fixture()
    writeFileSync(
      paths.bffDeploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: proompteng
          env:
            - name: TENGRI_GRPC_ENDPOINT
              value: ""
        - name: sidecar
          env:
            - name: TENGRI_GRPC_ENDPOINT
              value: sidecar.internal:50051
`,
    )

    updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)

    const deployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    expect(deployment).toContain(`value: ${TENGRI_GRPC_ENDPOINT}`)
    expect(deployment).toContain('value: sidecar.internal:50051')
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('does not accept a sidecar endpoint in place of the proompteng endpoint', () => {
    const paths = fixture()
    writeFileSync(
      paths.bffDeploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: proompteng
          env: []
        - name: sidecar
          env:
            - name: TENGRI_GRPC_ENDPOINT
              value: ${TENGRI_GRPC_ENDPOINT}
`,
    )

    expect(() => validateTengriRelease(paths)).toThrow(
      'Proompteng deployment must contain one literal TENGRI_GRPC_ENDPOINT, found 0',
    )
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'Proompteng deployment must contain one literal TENGRI_GRPC_ENDPOINT, found 0',
    )
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

  it('rejects a Tengri ApplicationSet entry that targets a different application', () => {
    const driftedTargets = [
      ['path: argocd/applications/tengri', 'path: argocd/applications/other'],
      ['namespace: tengri', 'namespace: other'],
      ['automation: auto', 'automation: manual'],
    ] as const

    for (const [expected, drifted] of driftedTargets) {
      const paths = fixture()
      writeFileSync(paths.applicationSetPath, readFileSync(paths.applicationSetPath, 'utf8').replace(expected, drifted))

      expect(() => validateTengriRelease(paths)).toThrow('Tengri ApplicationSet entry must target')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'Tengri ApplicationSet entry must target',
      )
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toContain(drifted)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects Tengri repository and revision overrides without mutating release manifests', () => {
    const overrides = [
      'repoURL: https://github.com/example/fork.git',
      'targetRevision: unverified-branch',
      'repoURL : https://github.com/example/fork.git',
      '"targetRevision": unverified-branch',
    ] as const

    for (const override of overrides) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(
          '                enabled: "false"',
          `                ${override}\n                enabled: "false"`,
        ),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must use the platform repository and main revision defaults')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must use the platform repository and main revision defaults',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects repository and revision overrides hidden in a YAML merge key', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '                enabled: "false"',
        '                <<: {repoURL: https://github.com/example/fork.git, targetRevision: unverified}\n                enabled: "false"',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must not use YAML merge keys')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow('must not use YAML merge keys')
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects source overrides after a nested sequence item named tengri', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '                enabled: "false"',
        `                ignoreDifferences:
                  - group: ""
                    kind: ConfigMap
                    name: tengri
                repoURL: https://github.com/example/fork.git
                targetRevision: unverified
                enabled: "false"`,
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must use the platform repository and main revision defaults')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must use the platform repository and main revision defaults',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects source overrides from the matrix cluster input', () => {
    const overrides = [
      'repoURL: https://github.com/example/fork.git',
      'targetRevision: unverified',
      '<<: {repoURL: https://github.com/example/fork.git}',
    ] as const

    for (const override of overrides) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(
          '              - cluster: in-cluster',
          `              - cluster: in-cluster\n                ${override}`,
        ),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('matrix inputs must not override the release source')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'matrix inputs must not override the release source',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects a Tengri entry moved into the matrix cluster generator', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    const tengriEntry = `              - name: tengri
                path: argocd/applications/tengri
                namespace: tengri
                automation: auto
                enabled: "false"
                managedNamespaceMetadata:
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
`
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8')
        .replace(tengriEntry, '')
        .replace('                suffix: ""', `                suffix: ""\n${tengriEntry}`),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must be in the application generator')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must be in the application generator',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects repository and revision overrides from templatePatch', () => {
    const overrides = [
      '        repoURL: https://github.com/example/fork.git',
      '        targetRevision: unverified',
    ] as const

    for (const override of overrides) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(
          '    {{- if or $useLovely $hasKustomize }}\n      source:\n',
          `    {{- if or $useLovely $hasKustomize }}\n      source:\n${override}\n`,
        ),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('plugin and kustomize-only source patch')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'plugin and kustomize-only source patch',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects template defaults that resolve Tengri to an unverified source', () => {
    const drifts = [
      ['https://github.com/proompteng/lab.git{{ end }}', 'https://github.com/example/fork.git{{ end }}'],
      ['{{ else }}main{{ end }}', '{{ else }}unverified{{ end }}'],
    ] as const

    for (const [expected, drifted] of drifts) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(paths.applicationSetPath, readFileSync(paths.applicationSetPath, 'utf8').replace(expected, drifted))
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('template must resolve to repository')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'template must resolve to repository',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
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
