import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

const digestReference =
  'registry.ide-newton.ts.net/lab/attic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

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

  it('rejects non-digest and non-canonical Attic references', () => {
    expect(() => __private.assertAtticImageDigest('registry.ide-newton.ts.net/lab/attic:latest')).toThrow(
      'Expected Attic digest reference',
    )
    expect(() =>
      __private.assertAtticImageDigest(
        'registry.ide-newton.ts.net/lab/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toThrow('Expected Attic digest reference')
  })
})
