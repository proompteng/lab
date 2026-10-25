import { expect, test } from 'bun:test'

import { type FileContent, validateActiveSaigakMigrationContent } from './validate-flamingo-hard-migration'

const validSaigakStatefulSet = `
apiVersion: apps/v1
kind: StatefulSet
spec:
  replicas: 1
  template:
    spec:
      runtimeClassName: nvidia
      nodeSelector:
        kubernetes.io/arch: arm64
        kubernetes.io/hostname: talos-192-168-1-85
        nvidia.com/gpu.present: "true"
      containers:
        - name: ollama
          resources:
            limits:
              nvidia.com/gpu: "1"
        - name: embedding-proxy
          env:
            - name: SAIGAK_REQUIRE_GPU_RESIDENCY
              value: "true"
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: saigak-altra-data
`

const validPlatform = `
ignoreDifferences:
  - group: ""
    kind: PersistentVolumeClaim
    name: saigak-data
    jsonPointers:
      - /metadata/annotations
      - /spec/volumeMode
      - /spec/volumeName
  - group: ""
    kind: PersistentVolumeClaim
    name: saigak-altra-data
    jsonPointers:
      - /metadata/annotations
      - /spec/volumeMode
      - /spec/volumeName
`

function filesWith(contentByPath: Partial<Record<string, string>> = {}): FileContent[] {
  return [
    {
      path: 'argocd/applications/saigak/statefulset.yaml',
      content: contentByPath['argocd/applications/saigak/statefulset.yaml'] ?? validSaigakStatefulSet,
    },
    {
      path: 'argocd/applicationsets/platform.yaml',
      content: contentByPath['argocd/applicationsets/platform.yaml'] ?? validPlatform,
    },
  ]
}

test('accepts the valid Saigak migration fixture', () => {
  expect(validateActiveSaigakMigrationContent(filesWith())).toEqual([])
})

test('requires SAIGAK_REQUIRE_GPU_RESIDENCY value to be true on the same env var entry', () => {
  const failures = validateActiveSaigakMigrationContent(
    filesWith({
      'argocd/applications/saigak/statefulset.yaml': validSaigakStatefulSet
        .replace(
          'name: SAIGAK_REQUIRE_GPU_RESIDENCY\n              value: "true"',
          'name: SAIGAK_REQUIRE_GPU_RESIDENCY\n              value: "false"',
        )
        .replace(
          'name: embedding-proxy\n          env:',
          'name: embedding-proxy\n          env:\n            - name: UNRELATED_FLAG\n              value: "true"',
        ),
    }),
  )

  expect(failures).toContain(
    'argocd/applications/saigak/statefulset.yaml: Saigak must set SAIGAK_REQUIRE_GPU_RESIDENCY=true on the embedding proxy',
  )
})

test('does not accept SAIGAK_REQUIRE_GPU_RESIDENCY from a non-proxy container', () => {
  const failures = validateActiveSaigakMigrationContent(
    filesWith({
      'argocd/applications/saigak/statefulset.yaml': validSaigakStatefulSet
        .replace(
          'name: embedding-proxy\n          env:\n            - name: SAIGAK_REQUIRE_GPU_RESIDENCY\n              value: "true"',
          'name: embedding-proxy\n          env:\n            - name: SAIGAK_REQUIRE_GPU_RESIDENCY\n              value: "false"',
        )
        .replace(
          'name: ollama\n          resources:',
          'name: ollama\n          env:\n            - name: SAIGAK_REQUIRE_GPU_RESIDENCY\n              value: "true"\n          resources:',
        ),
    }),
  )

  expect(failures).toContain(
    'argocd/applications/saigak/statefulset.yaml: Saigak must set SAIGAK_REQUIRE_GPU_RESIDENCY=true on the embedding proxy',
  )
})

test('requires saigak-altra-data PVC bound-field diff ignore', () => {
  const failures = validateActiveSaigakMigrationContent(
    filesWith({
      'argocd/applicationsets/platform.yaml': validPlatform.replace(
        /\n  - group: ""\n    kind: PersistentVolumeClaim\n    name: saigak-altra-data\n    jsonPointers:\n      - \/metadata\/annotations\n      - \/spec\/volumeMode\n      - \/spec\/volumeName\n/,
        '\n',
      ),
    }),
  )

  expect(failures).toContain(
    'argocd/applicationsets/platform.yaml: Saigak must ignore bound local-path PVC drift for saigak-altra-data',
  )
})
