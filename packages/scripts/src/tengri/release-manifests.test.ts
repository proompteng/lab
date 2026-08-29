import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readTengriRelease,
  TENGRI_APPLICATION_TEMPLATE_PATCH,
  TENGRI_GRPC_ENDPOINT,
  updateTengriRelease,
  validateTengriRelease,
  ZERO_DIGEST,
} from './release-manifests'

const tengriDigest = `sha256:${'a'.repeat(64)}`
const nanoagentDigest = `sha256:${'b'.repeat(64)}`
const indentedTemplatePatch = TENGRI_APPLICATION_TEMPLATE_PATCH.split('\n')
  .map((line) => `    ${line}`)
  .join('\n')

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
    `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - matrix:
        generators:
          - list:
              elements:
              - cluster: in-cluster
                suffix: ""
                destinationServer: https://kubernetes.default.svc
          - list:
              elements:
              - name: kata
                enabled: "true"
              - name: tengri
                path: argocd/applications/tengri
                namespace: tengri
                annotations:
                  argocd.argoproj.io/sync-wave: "2"
                automation: auto
                enabled: "${enabled}"
                ignoreDifferences:
                  - group: ""
                    kind: ConfigMap
                    name: tengri-auth-nonces
                    jsonPointers:
                      - /data
                managedNamespaceMetadata:
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
                    pod-security.kubernetes.io/audit: restricted
                    pod-security.kubernetes.io/warn: restricted
                    external-secrets.proompteng.ai/enabled: "true"
                  annotations:
                    argocd.argoproj.io/sync-options: Prune=false,Delete=false
              - name: cdi
                enabled: "true"
            selector:
              matchExpressions:
                - key: enabled
                  operator: NotIn
                  values: ["false", "False", "0"]
  template:
    metadata:
      name: '{{ .name }}{{ .suffix }}'
    spec:
      project: '{{ if hasKey . "project" }}{{ .project }}{{ else }}default{{ end }}'
      destination:
        namespace: '{{ if hasKey . "namespace" }}{{ .namespace }}{{ else }}{{ .name }}{{ end }}'
      source:
        repoURL: '{{ if hasKey . "repoURL" }}{{ .repoURL }}{{ else }}https://github.com/proompteng/lab.git{{ end }}'
        targetRevision: '{{ if hasKey . "targetRevision" }}{{ .targetRevision }}{{ else }}main{{ end }}'
        path: '{{ .path }}'
      syncPolicy:
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
          - RespectIgnoreDifferences=true
          - ApplyOutOfSyncOnly=true
          - PruneLast=true
          - ClientSideApplyMigration=false
  templatePatch: |
${indentedTemplatePatch}
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

  it('rejects a platform manifest that is not the canonical ApplicationSet resource', () => {
    for (const [expected, replacement] of [
      ['apiVersion: argoproj.io/v1alpha1', 'apiVersion: argoproj.io/v1beta1'],
      ['kind: ApplicationSet', 'kind: ConfigMap'],
    ] as const) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must be an argoproj.io/v1alpha1 ApplicationSet')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must be an argoproj.io/v1alpha1 ApplicationSet',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects an ApplicationSet outside the canonical resource identity', () => {
    for (const [expected, replacement] of [
      ['  name: platform', '  name: other'],
      ['  namespace: argocd', '  namespace: other'],
    ] as const) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must be metadata.name=platform in namespace argocd')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must be metadata.name=platform in namespace argocd',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects additional top-level generators without mutating release manifests', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '  template:\n',
        `    - list:
        elements:
          - name: tengri-shadow
            path: argocd/applications/tengri
            namespace: tengri
  template:
`,
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must contain exactly one verified top-level matrix generator')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must contain exactly one verified top-level matrix generator',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects mixed generator definitions without mutating release manifests', () => {
    const mixedDefinitions = [
      [
        '  template:\n',
        `      list:
        elements: []
  template:
`,
        'top-level generator must contain only the verified matrix generator',
      ],
      [
        '          - list:\n              elements:\n              - name: kata',
        `            git:
              repoURL: https://github.com/example/fork.git
              revision: HEAD
          - list:
              elements:
              - name: kata`,
        'matrix children must contain only their verified list generators',
      ],
      [
        '            selector:\n              matchExpressions:',
        `            git:
              repoURL: https://github.com/example/fork.git
              revision: HEAD
            selector:
              matchExpressions:`,
        'matrix children must contain only their verified list generators',
      ],
    ] as const

    for (const [expected, replacement, message] of mixedDefinitions) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow(message)
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(message)
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects elementsYaml overrides in either verified list generator', () => {
    const placements = [
      [
        '          - list:\n              elements:\n              - cluster: in-cluster',
        `          - list:
              elementsYaml: '[{"cluster":"other"}]'
              elements:
              - cluster: in-cluster`,
      ],
      [
        '          - list:\n              elements:\n              - name: kata',
        `          - list:
              elementsYaml: '[{"name":"other"}]'
              elements:
              - name: kata`,
      ],
    ] as const

    for (const [expected, replacement] of placements) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('list generators must contain only elements')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'list generators must contain only elements',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects YAML merge keys anywhere in the verified ApplicationSet spec', () => {
    const placements = [
      ['  generators:\n', '  <<: { strategy: { type: RollingSync } }\n  generators:\n'],
      [
        '      project: \'{{ if hasKey . "project" }}{{ .project }}{{ else }}default{{ end }}\'\n',
        `      <<: { sources: [] }
      project: '{{ if hasKey . "project" }}{{ .project }}{{ else }}default{{ end }}'
`,
      ],
    ] as const

    for (const [expected, replacement] of placements) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('spec must not contain YAML merge keys')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'spec must not contain YAML merge keys',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects rollout strategies that can hold the verified release', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '  generators:\n',
        `  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: name
              operator: In
              values: [tengri]
          maxUpdate: 0
  generators:
`,
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must not define a rollout strategy')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must not define a rollout strategy',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects unverified top-level ApplicationSet reconciliation controls', () => {
    const controls = [
      `  ignoreApplicationDifferences:
    - name: tengri
      jsonPointers:
        - /spec/source
`,
      `  syncPolicy:
    preserveResourcesOnDeletion: true
`,
    ] as const

    for (const control of controls) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace('  generators:\n', `${control}  generators:\n`),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('spec contains unsupported reconciliation fields')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'spec contains unsupported reconciliation fields',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects unverified Application template spec fields', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '      syncPolicy:\n',
        '      revisionHistoryLimit: 0\n      syncPolicy:\n',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('template spec contains unsupported fields')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'template spec contains unsupported fields',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects drift in the shared Application sync options', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '          - ServerSideApply=true',
        '          - ServerSideApply=false',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must preserve the verified sync options')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must preserve the verified sync options',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects selectors that filter the matrix before the verified application selector', () => {
    const selectorPlacements = [
      [
        '  template:\n',
        `      selector:
        matchLabels:
          enabled: never
  template:
`,
        'top-level matrix generator must not define a selector',
      ],
      [
        '          - list:\n              elements:\n              - name: kata',
        `            selector:
              matchLabels:
                cluster: other
          - list:
              elements:
              - name: kata`,
        'cluster generator must not define a selector',
      ],
    ] as const

    for (const [expected, replacement, message] of selectorPlacements) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow(message)
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(message)
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects multi-source application templates without mutating release manifests', () => {
    const sourceLists = [
      '      sources: []\n',
      `      sources:
        - repoURL: https://github.com/example/fork.git
          targetRevision: unverified
          path: argocd/applications/other
`,
    ] as const

    for (const sources of sourceLists) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace('      source:\n', `${sources}      source:\n`),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must use one verified source and must not define sources')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must use one verified source and must not define sources',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects conflicting singular-source render modes without mutating release manifests', () => {
    const conflictingModes = [
      '        chart: tengri\n',
      '        directory: {}\n',
      '        helm: {}\n',
      '        kustomize: {}\n',
      '        plugin: { name: other }\n',
    ] as const

    for (const mode of conflictingModes) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(
          "        path: '{{ .path }}'\n",
          `        path: '{{ .path }}'\n${mode}`,
        ),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow(
        'must contain only the verified repository, revision, and path',
      )
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must contain only the verified repository, revision, and path',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects an application template that does not produce the canonical name', () => {
    for (const replacement of ["      name: 'other'\n", '']) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace("      name: '{{ .name }}{{ .suffix }}'\n", replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('template must name applications')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'template must name applications',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects a generated Application namespace outside argocd', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        "      name: '{{ .name }}{{ .suffix }}'\n",
        "      name: '{{ .name }}{{ .suffix }}'\n      namespace: other\n",
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('template metadata must contain only the verified Application')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'template metadata must contain only the verified Application',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects base-template destinations that conflict with the verified destination patch', () => {
    const destinationFields = ['        name: other-cluster\n', '        server: https://other.example\n'] as const

    for (const destinationField of destinationFields) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace('      source:\n', `${destinationField}      source:\n`),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('base destination must contain only the verified namespace')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'base destination must contain only the verified namespace',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects global ignore rules that can match the Tengri Deployment', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '  templatePatch: |\n',
        `      ignoreDifferences:
        - group: apps
          kind: Deployment
          namespace: tengri
          name: tengri
          jsonPointers:
            - /spec/template/spec/containers/0/image
  templatePatch: |
`,
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('global ignoreDifferences must not match the Tengri Deployment')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'global ignoreDifferences must not match the Tengri Deployment',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
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

  it('rejects Tengri render-time overrides without mutating release manifests', () => {
    const overrides = [
      'renderWithLovely: false',
      `kustomize:
                  images:
                    - registry.ide-newton.ts.net/lab/tengri@sha256:${'c'.repeat(64)}`,
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

      expect(() => validateTengriRelease(paths)).toThrow('must not override verified rendering')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must not override verified rendering',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects broader Tengri ignore rules without mutating release manifests', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '                      - /data\n                managedNamespaceMetadata:',
        `                      - /data
                  - group: apps
                    kind: Deployment
                    name: tengri
                    jsonPointers:
                      - /spec/template/spec/containers/0/image
                managedNamespaceMetadata:`,
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must keep ignoreDifferences limited')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must keep ignoreDifferences limited',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
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

    expect(() => validateTengriRelease(paths)).toThrow('spec must not contain YAML merge keys')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'spec must not contain YAML merge keys',
    )
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
        '                      - /data\n                managedNamespaceMetadata:',
        `                      - /data
                repoURL: https://github.com/example/fork.git
                targetRevision: unverified
                managedNamespaceMetadata:`,
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
      const message = override.startsWith('<<')
        ? 'spec must not contain YAML merge keys'
        : 'matrix inputs must not override the release source'

      expect(() => validateTengriRelease(paths)).toThrow(message)
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(message)
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects a matrix cluster input that targets another destination', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        'destinationServer: https://kubernetes.default.svc',
        'destinationServer: https://other.example',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('cluster input must target')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow('cluster input must target')
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects project overrides from the matrix input', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '              - cluster: in-cluster',
        '              - cluster: in-cluster\n                project: unverified',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must not override the default project')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must not override the default project',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('requires the verified Go-template options', () => {
    const drifts = [
      ['  goTemplate: true\n', ''],
      ['  goTemplate: true', '  goTemplate: false'],
      ['  goTemplateOptions: ["missingkey=error"]', '  goTemplateOptions: []'],
      ['  goTemplateOptions: ["missingkey=error"]', '  goTemplateOptions: ["missingkey=zero"]'],
    ] as const

    for (const [expected, drifted] of drifts) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(paths.applicationSetPath, readFileSync(paths.applicationSetPath, 'utf8').replace(expected, drifted))
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must enable Go templating with missingkey=error')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must enable Go templating with missingkey=error',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects an application selector that excludes the enabled Tengri entry', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        '            selector:\n              matchExpressions:',
        '            selector:\n              matchLabels:\n                name: other\n              matchExpressions:',
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('selector must include the enabled Tengri entry')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'selector must include the enabled Tengri entry',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
  })

  it('rejects selector requirements with invalid cardinality, types, or label syntax', () => {
    const drifts = [
      ['values: ["false", "False", "0"]', 'values: []'],
      ['values: ["false", "False", "0"]', 'values: [false]'],
      ['values: ["false", "False", "0"]', 'values: ["bad value"]'],
      ['values: ["false", "False", "0"]', `values: ["${'a'.repeat(64)}"]`],
      ['key: enabled', 'key: example.com/bad$key'],
      ['operator: NotIn', 'operator: Exists'],
    ] as const

    for (const [expected, drifted] of drifts) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(paths.applicationSetPath, readFileSync(paths.applicationSetPath, 'utf8').replace(expected, drifted))
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('selector contains an invalid expression')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'selector contains an invalid expression',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects matrix and list generator templates that override the verified application template', () => {
    const overrides = [
      [
        '    - matrix:\n        generators:',
        `    - matrix:
        template:
          spec:
            destination:
              server: https://other.example
            source:
              repoURL: https://github.com/example/fork.git
              targetRevision: unverified
              path: argocd/applications/other
        generators:`,
      ],
      [
        '          - list:\n              elements:\n              - cluster: in-cluster',
        `          - list:
              template:
                spec:
                  source:
                    path: argocd/applications/other
              elements:
              - cluster: in-cluster`,
      ],
      [
        '          - list:\n              elements:\n              - name: kata',
        `          - list:
              template:
                spec:
                  source:
                    repoURL: https://github.com/example/fork.git
              elements:
              - name: kata`,
      ],
    ] as const

    for (const [expected, override] of overrides) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(expected, override),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must not define generator-level templates')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must not define generator-level templates',
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
                annotations:
                  argocd.argoproj.io/sync-wave: "2"
                automation: auto
                enabled: "false"
                ignoreDifferences:
                  - group: ""
                    kind: ConfigMap
                    name: tengri-auth-nonces
                    jsonPointers:
                      - /data
                managedNamespaceMetadata:
                  labels:
                    pod-security.kubernetes.io/enforce: restricted
                    pod-security.kubernetes.io/audit: restricted
                    pod-security.kubernetes.io/warn: restricted
                    external-secrets.proompteng.ai/enabled: "true"
                  annotations:
                    argocd.argoproj.io/sync-options: Prune=false,Delete=false
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

  it('rejects source overrides from templatePatch', () => {
    const overrides = [
      '        repoURL: https://github.com/example/fork.git',
      '        targetRevision: unverified',
      '        path: argocd/applications/other',
      '        "path": argocd/applications/other',
      "        'repoURL': https://github.com/example/fork.git",
      '        "\\u0070ath": argocd/applications/other',
      '        ? path\n        : argocd/applications/other',
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

  it('rejects a templatePatch destination that stops projecting the verified in-cluster server', () => {
    const paths = fixture()
    const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
    const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
    writeFileSync(
      paths.applicationSetPath,
      readFileSync(paths.applicationSetPath, 'utf8').replace(
        "server: '{{ .destinationServer }}'",
        "server: 'https://other.example'",
      ),
    )
    const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

    expect(() => validateTengriRelease(paths)).toThrow('must preserve the verified destination')
    expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
      'must preserve the verified destination',
    )
    expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
    expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
    expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
    rmSync(paths.directory, { recursive: true, force: true })
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

  it('rejects a global template that resolves Tengri to another project', () => {
    for (const replacement of ["      project: 'unverified'\n", '']) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace(
          `      project: '{{ if hasKey . "project" }}{{ .project }}{{ else }}default{{ end }}'\n`,
          replacement,
        ),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must resolve Tengri to the default project')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must resolve Tengri to the default project',
      )
      expect(readFileSync(paths.kustomizationPath, 'utf8')).toBe(beforeKustomization)
      expect(readFileSync(paths.applicationSetPath, 'utf8')).toBe(driftedApplicationSet)
      expect(readFileSync(paths.bffDeploymentPath, 'utf8')).toBe(beforeBffDeployment)
      rmSync(paths.directory, { recursive: true, force: true })
    }
  })

  it('rejects a template that does not project the application source path', () => {
    for (const replacement of ["        path: 'argocd/applications/other'\n", '']) {
      const paths = fixture()
      const beforeKustomization = readFileSync(paths.kustomizationPath, 'utf8')
      const beforeBffDeployment = readFileSync(paths.bffDeploymentPath, 'utf8')
      writeFileSync(
        paths.applicationSetPath,
        readFileSync(paths.applicationSetPath, 'utf8').replace("        path: '{{ .path }}'\n", replacement),
      )
      const driftedApplicationSet = readFileSync(paths.applicationSetPath, 'utf8')

      expect(() => validateTengriRelease(paths)).toThrow('must resolve source path from the application entry')
      expect(() => updateTengriRelease({ tengriDigest, nanoagentDigest }, paths)).toThrow(
        'must resolve source path from the application entry',
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
