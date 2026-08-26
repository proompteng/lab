import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const imagesPath = resolve(repositoryRoot, '.github/workflows/tengri-images.yml')
const releasePath = resolve(repositoryRoot, '.github/workflows/tengri-release.yml')

describe('Tengri release workflows', () => {
  it('connects promotion to the image workflow release contract', () => {
    const imagesSource = readFileSync(imagesPath, 'utf8')
    const releaseSource = readFileSync(releasePath, 'utf8')
    const images = YAML.parse(imagesSource) as { name?: string }
    const release = YAML.parse(releaseSource) as {
      on?: { workflow_run?: { workflows?: string[] } }
    }

    expect(images.name).toBe('Tengri images')
    expect(release.on?.workflow_run?.workflows).toEqual([images.name])
    expect(imagesSource).toContain('name: tengri-release-contract')
    expect(releaseSource).toContain('name: tengri-release-contract')
  })

  it('builds and signs both native architectures from one source revision', () => {
    const source = readFileSync(imagesPath, 'utf8')

    expect(source).toContain('service: tengri')
    expect(source).toContain('service: nanoagent')
    expect(source).toContain('architecture: amd64')
    expect(source).toContain('architecture: arm64')
    expect(source).toContain('cosign sign --yes')
    expect(source).toContain('digest="sha256:$(sha256sum "${index_path}"')
    expect(source).not.toContain('.Manifest.Digest')
    expect(source).toContain('sourceSha: $sourceSha')
  })

  it('verifies the exact publishing workflow identity before promotion', () => {
    const source = readFileSync(releasePath, 'utf8')

    expect(source).toContain('.github/workflows/tengri-images.yml@refs/heads/main')
    expect(source).toContain('test "$(jq -r \'.signed\' "$contract")" = true')
    expect(source).toContain('test "sha256:$(sha256sum "${service}-index.json"')
    expect(source).toContain('bun packages/scripts/src/tengri/update-release.ts')
    expect(source).toContain('bun packages/scripts/src/tengri/validate-release.ts')
  })

  it('reuses a verified image when only deployment manifests changed', () => {
    const release = YAML.parse(readFileSync(releasePath, 'utf8')) as {
      jobs?: { promote?: { steps?: Array<{ name?: string; run?: string }> } }
    }
    const validation = release.jobs?.promote?.steps?.find(
      (step) => step.name === 'Validate release contract and published images',
    )?.run

    expect(validation).toContain('services/tengri')
    expect(validation).toContain('services/nanoagent')
    expect(validation).toContain('packages/scripts/src/tengri')
    expect(validation).not.toContain('argocd/applications/tengri')
    expect(validation).not.toContain('argocd/applications/kata')
    expect(validation).not.toContain('argocd/applicationsets/platform.yaml')
  })
})
