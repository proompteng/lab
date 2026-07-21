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
  test('atomically promotes the current runtime and removes the legacy qualification pin', () => {
    directory = mkdtempSync(join(tmpdir(), 'bayn-manifest-'))
    const kustomizationPath = join(directory, 'kustomization.yaml')
    const deploymentPath = join(directory, 'deployment.yaml')
    const applicationSetPath = join(directory, 'product.yaml')
    writeFileSync(
      kustomizationPath,
      `images:\n  - name: registry.ide-newton.ts.net/lab/bayn\n    newName: registry.ide-newton.ts.net/lab/bayn\n    newTag: bootstrap\n`,
    )
    writeFileSync(
      deploymentPath,
      `metadata:\n  template:\n    metadata:\n      annotations:\n        kubectl.kubernetes.io/restartedAt: "old"\n    spec:\n      containers:\n        - env:\n            - name: BAYN_CODE_REVISION\n              value: bootstrap\n            - name: BAYN_IMAGE_REPOSITORY\n              value: registry.ide-newton.ts.net/lab/bayn\n            - name: BAYN_IMAGE_DIGEST\n              value: sha256:old\n            - name: BAYN_QUALIFICATION_RUN_ID\n              value: legacy-run\n            - name: BAYN_SIGNAL_SNAPSHOT_ID\n              value: legacy-snapshot\n            - name: BAYN_SIGNAL_PUBLICATION_ASOF\n              value: 2026-07-19\n            - name: BAYN_SIGNAL_CALENDAR_VERSION\n              value: legacy-calendar\n            - name: BAYN_SIGNAL_DATA_START\n              value: 2017-01-03\n            - name: BAYN_SIGNAL_DATA_END\n              value: 2026-07-19\n            - name: BAYN_SIGNAL_LOOKBACK_START\n              value: 2017-01-03\n            - name: BAYN_SIGNAL_EVALUATION_START\n              value: 2018-01-03\n            - name: BAYN_SIGNAL_EVALUATION_END\n              value: 2026-07-19\n            - name: BAYN_TIGERBEETLE_CLUSTER_ID\n              value: "2001"\n            - name: BAYN_TIGERBEETLE_ADDRESSES\n              value: old-ledger.example:3000\n            - name: BAYN_TIGERBEETLE_LEDGER\n              value: "7001"\n`,
    )
    writeFileSync(
      applicationSetPath,
      `elements:\n              - name: bayn\n                path: argocd/applications/bayn\n                enabled: "false"\n              - name: next\n                enabled: "true"\n`,
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
      applicationSetPath,
    })
    expect(readFileSync(kustomizationPath, 'utf8')).toContain(`newTag: "sha-${sourceSha}"\n    digest: ${digest}`)
    expect(readFileSync(deploymentPath, 'utf8')).toContain(`value: ${sourceSha}`)
    expect(readFileSync(deploymentPath, 'utf8')).toContain(
      `- name: BAYN_IMAGE_REPOSITORY\n              value: registry.ide-newton.ts.net/lab/bayn`,
    )
    expect(readFileSync(deploymentPath, 'utf8')).toContain(`- name: BAYN_IMAGE_DIGEST\n              value: ${digest}`)
    expect(readFileSync(deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(readFileSync(deploymentPath, 'utf8')).toContain(
      '- name: BAYN_SIGNAL_SNAPSHOT_ID\n              value: "98f9b0cdee311b248d4ed36104fa46ff86c34d587d6e71a6706a9d778c110292"',
    )
    expect(readFileSync(deploymentPath, 'utf8')).toContain(
      '- name: BAYN_SIGNAL_EVALUATION_START\n              value: "2023-01-30"',
    )
    expect(readFileSync(deploymentPath, 'utf8')).toContain(
      '- name: BAYN_TIGERBEETLE_CLUSTER_ID\n              value: "122731676035874920802382025803517750735"',
    )
    expect(readFileSync(deploymentPath, 'utf8')).toContain(
      '- name: BAYN_TIGERBEETLE_ADDRESSES\n              value: "ledger.bayn.svc.cluster.local:3000"',
    )
    expect(readFileSync(deploymentPath, 'utf8')).toContain('restartedAt: "2026-07-19T10:00:00Z"')
    expect(readFileSync(applicationSetPath, 'utf8')).toContain(
      '- name: bayn\n                path: argocd/applications/bayn\n                enabled: "true"',
    )

    const nextSourceSha = 'c'.repeat(40)
    updateBaynManifests({
      sourceSha: nextSourceSha,
      tag: `sha-${nextSourceSha}`,
      digest: `sha256:${'d'.repeat(64)}`,
      rolloutTimestamp: '2026-07-20T10:00:00Z',
      kustomizationPath,
      deploymentPath,
      applicationSetPath,
    })
    expect(readFileSync(deploymentPath, 'utf8')).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(readFileSync(deploymentPath, 'utf8')).toContain(`value: ${nextSourceSha}`)
  })

  test('rejects malformed release metadata', () => {
    expect(() =>
      updateBaynManifests({
        sourceSha: 'main',
        tag: 'latest',
        digest: 'sha256:bad',
        rolloutTimestamp: 'now',
        applicationSetPath: 'unused',
      }),
    ).toThrow('invalid source SHA')
  })
})
