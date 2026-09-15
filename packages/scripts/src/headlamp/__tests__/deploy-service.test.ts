import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

const digestReference =
  'registry.ide-newton.ts.net/lab/headlamp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('headlamp deploy-service helpers', () => {
  it('parses dry-run, no-apply, image, values, and rollout flags', () => {
    expect(
      __private.parseArgs([
        '--dry-run',
        '--no-apply',
        '--tag=sha-test',
        '--registry',
        'registry.ide-newton.ts.net',
        '--repository=lab/headlamp',
        '--values-path=argocd/applications/headlamp/values.yaml',
        '--kustomize-path=argocd/applications/headlamp',
        '--namespace',
        'headlamp',
        '--deployment=headlamp',
      ]),
    ).toEqual({
      dryRun: true,
      apply: false,
      tag: 'sha-test',
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/headlamp',
      valuesPath: 'argocd/applications/headlamp/values.yaml',
      kustomizePath: 'argocd/applications/headlamp',
      namespace: 'headlamp',
      deploymentName: 'headlamp',
    })
  })

  it('updates the Helm values image repository and digest tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'headlamp-deploy-values-'))
    const valuesPath = join(dir, 'values.yaml')

    writeFileSync(
      valuesPath,
      `service:
  type: ClusterIP
image:
  registry: registry.ide-newton.ts.net
  repository: lab/headlamp@sha256
  tag: 1111111111111111111111111111111111111111111111111111111111111111
`,
    )

    __private.updateHeadlampValues({
      imageDigest: digestReference,
      valuesPath,
    })

    const updated = readFileSync(valuesPath, 'utf8')
    expect(updated).toContain('repository: lab/headlamp@sha256')
    expect(updated).toContain('tag: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects non-digest and non-canonical Headlamp references', () => {
    expect(() => __private.assertHeadlampImageDigest('registry.ide-newton.ts.net/lab/headlamp:latest')).toThrow(
      'Expected Headlamp digest reference',
    )
    expect(() =>
      __private.assertHeadlampImageDigest(
        'registry.ide-newton.ts.net/lab/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toThrow('Expected Headlamp digest reference')
  })
})
