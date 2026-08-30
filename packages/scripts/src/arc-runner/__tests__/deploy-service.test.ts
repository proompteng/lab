import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

const digestReference =
  'registry.ide-newton.ts.net/lab/arc-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const arcApplicationFixture = (imageReference: string): string => `apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  sources:
    - helm:
        valuesObject:
          runnerScaleSetName: arc-arm64
          template:
            spec:
              initContainers:
                - name: init-dind-externals
                  image: ${imageReference}
              containers:
                - name: runner
                  image: ${imageReference}
                - name: dind
                  image: docker:dind
    - helm:
        valuesObject:
          runnerScaleSetName: arc-amd64
          template:
            spec:
              initContainers:
                - name: init-dind-externals
                  image: ${imageReference}
              containers:
                - name: runner
                  image: ${imageReference}
                - name: dind
                  image: docker:dind
    - helm:
        valuesObject:
          runnerScaleSetName: analysis-arm64
          template:
            spec:
              initContainers:
                - name: init-dind-externals
                  image: ${imageReference}
              containers:
                - name: runner
                  image: ${imageReference}
                - name: dind
                  image: docker:dind
`

describe('arc-runner deploy-service helpers', () => {
  it('requires a multi-arch image index before ARC manifests can be updated', () => {
    expect(() =>
      __private.assertArcRunnerDeployableImage({
        digest: digestReference,
        platforms: ['linux/arm64'],
      }),
    ).toThrow('missing required platform(s): linux/amd64')

    expect(
      __private.assertArcRunnerDeployableImage({
        digest: digestReference,
        platforms: ['linux/amd64', 'linux/arm64'],
      }),
    ).toBe(digestReference)
  })

  it('updates all ARC runner image references after multi-arch validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-runner-deploy-manifests-'))
    const applicationPath = join(dir, 'application.yaml')
    const oldReference =
      'registry.ide-newton.ts.net/lab/arc-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111'

    writeFileSync(applicationPath, arcApplicationFixture(oldReference))

    const imageReference = __private.assertArcRunnerDeployableImage({
      digest: digestReference,
      platforms: ['linux/amd64', 'linux/arm64'],
    })
    __private.updateArcRunnerImageManifests(imageReference, applicationPath)

    expect(
      readFileSync(applicationPath, 'utf8').match(/registry\.ide-newton\.ts\.net\/lab\/arc-runner@sha256:a{64}/g),
    ).toHaveLength(6)

    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects single-platform or non-canonical ARC runner references', () => {
    expect(() =>
      __private.assertArcRunnerDeployableImage({
        digest: 'registry.ide-newton.ts.net/lab/arc-runner:latest',
        platforms: ['linux/amd64', 'linux/arm64'],
      }),
    ).toThrow('Expected ARC runner digest reference')

    expect(() =>
      __private.assertArcRunnerDeployableImage({
        digest: digestReference,
        platforms: [],
      }),
    ).toThrow('observed: none')
  })
})
