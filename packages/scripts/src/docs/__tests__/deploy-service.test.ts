import { describe, expect, it } from 'bun:test'

import { __private } from '../deploy-service'

const kustomization = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - generated
images:
  - name: registry.ide-newton.ts.net/lab/docs
    digest: sha256:${'a'.repeat(64)}
    newName: registry.ide-newton.ts.net/lab/docs
`

describe('docs manifest promotion', () => {
  it('updates the parent Kustomization without changing the generated resource boundary', () => {
    const nextDigest = `sha256:${'b'.repeat(64)}`
    const updated = __private.updateKustomizationContent(
      kustomization,
      `registry.ide-newton.ts.net/lab/docs@${nextDigest}`,
    )

    expect(updated).toContain('resources:\n  - generated')
    expect(updated).toContain(`digest: ${nextDigest}`)
    expect(updated).toContain('newName: registry.ide-newton.ts.net/lab/docs')
  })

  it('fails closed when the expected image entry is absent', () => {
    expect(() =>
      __private.updateKustomizationContent(
        'resources:\n  - generated\n',
        `registry.ide-newton.ts.net/lab/docs@sha256:${'b'.repeat(64)}`,
      ),
    ).toThrow('image entry was not found')
  })
})
