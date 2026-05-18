import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { resolvePublishedAgentsImages } from '../resolve-published-agents-images'

describe('resolvePublishedAgentsImages', () => {
  it('uses immutable Agents image pins from the GitOps values file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-published-agents-images-'))
    const valuesPath = join(dir, 'values.yaml')

    writeFileSync(
      valuesPath,
      `
image:
  repository: registry.example/lab/agents-controller
  tag: abcdef12
  digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
controlPlane:
  image:
    repository: registry.example/lab/agents-control-plane
    tag: control12
    digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  env:
    vars:
      AGENTS_SOURCE_HEAD_SHA: abcdef1234567890abcdef1234567890abcdef12
controllers:
  image:
    repository: registry.example/lab/agents-controller
    tag: controller12
    digest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
`,
      'utf8',
    )

    expect(resolvePublishedAgentsImages(relative(repoRoot, valuesPath))).toEqual({
      sourceSha: 'abcdef1234567890abcdef1234567890abcdef12',
      controlPlane: {
        repository: 'registry.example/lab/agents-control-plane',
        tag: 'control12',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ref: 'registry.example/lab/agents-control-plane:control12@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      controller: {
        repository: 'registry.example/lab/agents-controller',
        tag: 'controller12',
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ref: 'registry.example/lab/agents-controller:controller12@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    })

    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the root image fields for omitted component values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-published-agents-images-'))
    const valuesPath = join(dir, 'values.yaml')

    writeFileSync(
      valuesPath,
      `
image:
  repository: registry.example/lab/agents-control-plane
  tag: abcdef12
  digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
controlPlane: {}
controllers:
  image:
    repository: registry.example/lab/agents-controller
`,
      'utf8',
    )

    expect(resolvePublishedAgentsImages(relative(repoRoot, valuesPath))).toEqual({
      sourceSha: 'abcdef12',
      controlPlane: {
        repository: 'registry.example/lab/agents-control-plane',
        tag: 'abcdef12',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ref: 'registry.example/lab/agents-control-plane:abcdef12@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      controller: {
        repository: 'registry.example/lab/agents-controller',
        tag: 'abcdef12',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ref: 'registry.example/lab/agents-controller:abcdef12@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })

    rmSync(dir, { recursive: true, force: true })
  })
})
