import { describe, expect, test } from 'bun:test'

import { updateSignalPublisherManifests } from './update-manifests'

const manifests = {
  kustomization:
    'images:\n  - name: registry.ide-newton.ts.net/lab/signal-publisher\n    newName: registry.ide-newton.ts.net/lab/signal-publisher\n    newTag: bootstrap\n',
  cronJob: `spec:\n  suspend: true\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - env:\n                - name: SIGNAL_CODE_REVISION\n                  value: bootstrap\n                - name: SIGNAL_IMAGE_DIGEST\n                  value: sha256:old\n`,
}

describe('Signal publisher manifest promotion', () => {
  test('pins the immutable image, binds provenance, and activates the CronJob', () => {
    const sourceSha = 'a'.repeat(40)
    const digest = `sha256:${'b'.repeat(64)}`
    const updated = updateSignalPublisherManifests({ sourceSha, tag: `sha-${sourceSha}`, digest }, manifests)

    expect(updated.kustomization).toContain(`newTag: "sha-${sourceSha}"\n    digest: ${digest}`)
    expect(updated.cronJob).toContain('suspend: false')
    expect(updated.cronJob).toContain(`- name: SIGNAL_CODE_REVISION\n                  value: ${sourceSha}`)
    expect(updated.cronJob).toContain(`- name: SIGNAL_IMAGE_DIGEST\n                  value: ${digest}`)
  })

  test('rejects malformed release metadata without changing inputs', () => {
    expect(() =>
      updateSignalPublisherManifests({ sourceSha: 'main', tag: 'latest', digest: 'sha256:bad' }, manifests),
    ).toThrow('invalid source SHA')
    expect(manifests.kustomization).toContain('newTag: bootstrap')
    expect(manifests.cronJob).toContain('suspend: true')
  })
})
