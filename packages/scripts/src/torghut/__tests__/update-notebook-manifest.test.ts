import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

import { __private } from '../update-notebook-manifest'

describe('update-notebook-manifest', () => {
  it('updates only the singleuser image digest tag', () => {
    const directory = mkdtempSync(join(tmpdir(), 'torghut-notebook-values-'))
    const path = join(directory, 'values.yaml')
    const original = `hub:
  image:
    name: quay.io/jupyterhub/k8s-hub
    tag: '4.4.0'
singleuser:
  image:
    name: registry.ide-newton.ts.net/lab/torghut-notebook@sha256
    tag: '${'a'.repeat(64)}'
  cpu:
    guarantee: 2
`
    writeFileSync(path, original)

    const result = __private.updateNotebookManifest(
      'registry.ide-newton.ts.net/lab/torghut-notebook',
      `sha256:${'b'.repeat(64)}`,
      path,
    )

    expect(result.changed).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original.replace('a'.repeat(64), 'b'.repeat(64)))
  })

  it('rejects an unexpected image repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'torghut-notebook-values-'))
    const path = join(directory, 'values.yaml')
    writeFileSync(
      path,
      `singleuser:\n  image:\n    name: example.invalid/notebook@sha256\n    tag: ${'a'.repeat(64)}\n`,
    )
    expect(() =>
      __private.updateNotebookManifest(
        'registry.ide-newton.ts.net/lab/torghut-notebook',
        `sha256:${'b'.repeat(64)}`,
        path,
      ),
    ).toThrow('Notebook image name must be')
  })
})
