import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

const digestReference =
  'registry.ide-newton.ts.net/lab/attic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const stagingDigestReference =
  'registry.example.test/staging/attic@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('attic deploy-service helpers', () => {
  it('parses dry-run, no-apply, image, and rollout flags', () => {
    expect(
      __private.parseArgs([
        '--dry-run',
        '--no-apply',
        '--tag=sha-test',
        '--registry',
        'registry.ide-newton.ts.net',
        '--repository=lab/attic',
        '--image-digest',
        digestReference,
        '--kustomize-path=argocd/applications/attic',
        '--namespace',
        'attic',
        '--deployment=attic',
      ]),
    ).toEqual({
      dryRun: true,
      apply: false,
      tag: 'sha-test',
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/attic',
      imageDigest: digestReference,
      kustomizePath: 'argocd/applications/attic',
      namespace: 'attic',
      deploymentName: 'attic',
    })
  })

  it('updates Attic API, migration, and GC image references together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attic-deploy-manifests-'))
    const deploymentPath = join(dir, 'deployment.yaml')
    const gcCronJobPath = join(dir, 'gc-cronjob.yaml')

    writeFileSync(
      deploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: db-migrations
          image: registry.ide-newton.ts.net/lab/attic@sha256:1111111111111111111111111111111111111111111111111111111111111111
      containers:
        - name: attic
          image: registry.ide-newton.ts.net/lab/attic:latest
`,
    )
    writeFileSync(
      gcCronJobPath,
      `apiVersion: batch/v1
kind: CronJob
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: attic-gc
              image: registry.ide-newton.ts.net/lab/attic@sha256:2222222222222222222222222222222222222222222222222222222222222222
`,
    )

    __private.updateAtticImageManifests({
      imageDigest: digestReference,
      deploymentPath,
      gcCronJobPath,
    })

    expect(
      readFileSync(deploymentPath, 'utf8').match(/registry\.ide-newton\.ts\.net\/lab\/attic@sha256:a{64}/g),
    ).toHaveLength(2)
    expect(
      readFileSync(gcCronJobPath, 'utf8').match(/registry\.ide-newton\.ts\.net\/lab\/attic@sha256:a{64}/g),
    ).toHaveLength(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('updates manifests under the selected kustomize path with the configured image name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attic-staging-kustomize-'))
    const deploymentPath = join(dir, 'deployment.yaml')
    const gcCronJobPath = join(dir, 'gc-cronjob.yaml')

    writeFileSync(
      deploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: db-migrations
          image: registry.ide-newton.ts.net/lab/attic@sha256:1111111111111111111111111111111111111111111111111111111111111111
      containers:
        - name: attic
          image: registry.ide-newton.ts.net/lab/attic:latest
`,
    )
    writeFileSync(
      gcCronJobPath,
      `apiVersion: batch/v1
kind: CronJob
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: attic-gc
              image: registry.ide-newton.ts.net/lab/attic@sha256:2222222222222222222222222222222222222222222222222222222222222222
`,
    )

    __private.updateAtticImageManifests({
      imageDigest: stagingDigestReference,
      registry: 'registry.example.test',
      repository: 'staging/attic',
      kustomizePath: dir,
    })

    expect(
      readFileSync(deploymentPath, 'utf8').match(/registry\.example\.test\/staging\/attic@sha256:b{64}/g),
    ).toHaveLength(2)
    expect(
      readFileSync(gcCronJobPath, 'utf8').match(/registry\.example\.test\/staging\/attic@sha256:b{64}/g),
    ).toHaveLength(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('clears stale architecture selectors while pinning multi-arch manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attic-clear-arch-selector-'))
    const deploymentPath = join(dir, 'deployment.yaml')
    const gcCronJobPath = join(dir, 'gc-cronjob.yaml')

    writeFileSync(
      deploymentPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      initContainers:
        - name: db-migrations
          image: registry.ide-newton.ts.net/lab/attic:latest
      containers:
        - name: attic
          image: registry.ide-newton.ts.net/lab/attic:latest
`,
    )
    writeFileSync(
      gcCronJobPath,
      `apiVersion: batch/v1
kind: CronJob
spec:
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector:
            kubernetes.io/arch: arm64
          containers:
            - name: attic-gc
              image: registry.ide-newton.ts.net/lab/attic:latest
`,
    )

    __private.updateAtticImageManifests({
      imageDigest: digestReference,
      deploymentPath,
      gcCronJobPath,
    })

    expect(readFileSync(deploymentPath, 'utf8')).not.toContain('kubernetes.io/arch')
    expect(readFileSync(gcCronJobPath, 'utf8')).not.toContain('kubernetes.io/arch')

    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects non-digest and non-canonical Attic references', () => {
    expect(() => __private.assertAtticImageDigest('registry.ide-newton.ts.net/lab/attic:latest')).toThrow(
      'Expected Attic digest reference',
    )
    expect(() =>
      __private.assertAtticImageDigest(
        'registry.ide-newton.ts.net/lab/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toThrow('Expected Attic digest reference')
    expect(() => __private.assertAtticImageDigest(digestReference, 'registry.example.test/staging/attic')).toThrow(
      'Expected Attic digest reference registry.example.test/staging/attic@sha256:<64 hex>',
    )
  })

  it('requires a multi-arch image before pinning deploy manifests', () => {
    expect(__private.assertRequiredImagePlatforms(['linux/amd64', 'linux/arm64'])).toEqual([
      'linux/amd64',
      'linux/arm64',
    ])
    expect(() => __private.assertRequiredImagePlatforms(['linux/arm64'])).toThrow(
      'must include required platform(s) before manifests can be pinned: linux/amd64',
    )
  })

  it('requires a prebuilt digest for non-dry deploys instead of building a host-only image', () => {
    expect(() =>
      __private.requireDeployImageDigest({
        dryRun: false,
        apply: false,
        registry: 'registry.ide-newton.ts.net',
        repository: 'lab/attic',
        tag: 'sha-test',
        kustomizePath: 'argocd/applications/attic',
        namespace: 'attic',
        deploymentName: 'attic',
      }),
    ).toThrow('Non-dry attic:deploy requires --image-digest / ATTIC_IMAGE_DIGEST')

    expect(
      __private.requireDeployImageDigest({
        dryRun: false,
        apply: false,
        registry: 'registry.ide-newton.ts.net',
        repository: 'lab/attic',
        tag: 'sha-test',
        imageDigest: digestReference,
        kustomizePath: 'argocd/applications/attic',
        namespace: 'attic',
        deploymentName: 'attic',
      }),
    ).toBe(digestReference)
  })
})
