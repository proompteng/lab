import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const imagesPath = resolve(repositoryRoot, '.github/workflows/tengri-images.yml')
const controllerPath = resolve(repositoryRoot, '.github/workflows/tengri-controller.yaml')
const releasePath = resolve(repositoryRoot, '.github/workflows/tengri-release.yml')
const nanoagentDockerfilePath = resolve(repositoryRoot, 'services/nanoagent/Dockerfile')
const tengriDockerfilePath = resolve(repositoryRoot, 'services/tengri/Dockerfile')
const tengriReadmePath = resolve(repositoryRoot, 'services/tengri/README.md')

describe('Tengri release workflows', () => {
  it('connects promotion to the image workflow release contract', () => {
    const imagesSource = readFileSync(imagesPath, 'utf8')
    const releaseSource = readFileSync(releasePath, 'utf8')
    const images = YAML.parse(imagesSource) as { name?: string }
    const release = YAML.parse(releaseSource) as {
      on?: { workflow_run?: { workflows?: string[]; branches?: string[] } }
    }

    expect(images.name).toBe('Tengri images')
    expect(release.on?.workflow_run?.workflows).toEqual(['Tengri images'])
    expect(release.on?.workflow_run?.branches).toEqual(['main'])
    expect(imagesSource).toContain('name: tengri-release-contract')
    expect(releaseSource).toContain('name: tengri-release-contract')
  })

  it('documents the publisher and generated promotion handoff', () => {
    const readme = readFileSync(tengriReadmePath, 'utf8')

    expect(readme).toContain('`Tengri images`')
    expect(readme).toContain('`Tengri release`')
    expect(readme).toContain('generated promotion PR')
    expect(readme).not.toContain('Roll out only through the `Tengri controller` workflow')
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

  it('gates the sole Tengri publisher on full controller validation', () => {
    const imagesSource = readFileSync(imagesPath, 'utf8')
    const controllerSource = readFileSync(controllerPath, 'utf8')
    const images = YAML.parse(imagesSource) as {
      jobs?: {
        'validate-tengri'?: { steps?: Array<{ run?: string }> }
        publish?: { needs?: string[] }
      }
    }
    const validation = images.jobs?.['validate-tengri']?.steps?.map((step) => step.run ?? '').join('\n')

    expect(validation).toContain('cargo fmt --check')
    expect(validation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(validation).toContain('cargo test --locked --all-targets')
    expect(validation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
    expect(images.jobs?.publish?.needs).toContain('validate-tengri')
    expect(controllerSource).not.toContain('docker/build-push-action')
    expect(controllerSource).not.toContain('cosign sign')
  })

  it('uses the repository mirror instead of anonymous Docker Hub base pulls', () => {
    const nanoagent = readFileSync(nanoagentDockerfilePath, 'utf8')
    const tengri = readFileSync(tengriDockerfilePath, 'utf8')

    for (const dockerfile of [nanoagent, tengri]) {
      expect(dockerfile).toStartWith('# syntax=mirror.gcr.io/docker/dockerfile:1.7')
      expect(dockerfile).not.toContain('docker.io/')
    }
    expect(nanoagent).toContain('ARG GO_BASE_IMAGE=mirror.gcr.io/golang')
    expect(nanoagent).toContain('ARG NODE_BASE_IMAGE=mirror.gcr.io/node')
    expect(nanoagent).toContain('ARG RUST_BASE_IMAGE=mirror.gcr.io/rust')
    expect(nanoagent).toContain('ARG UBUNTU_BASE_IMAGE=mirror.gcr.io/ubuntu')
    expect(nanoagent).toContain('"bun@${BUN_VERSION}"')
    expect(nanoagent).not.toContain('oven/bun')
    expect(tengri).toContain('ARG DEBIAN_BASE_IMAGE=mirror.gcr.io/debian')
    expect(tengri).toContain('ARG RUST_BASE_IMAGE=mirror.gcr.io/rust')
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

  it('refreshes manifest drift without rebuilding promoted images and guards every release-tool dependency', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      on?: { pull_request?: { paths?: string[] }; push?: { paths?: string[] } }
    }
    const release = YAML.parse(readFileSync(releasePath, 'utf8')) as {
      concurrency?: { group?: string }
      jobs?: {
        promote?: { steps?: Array<{ name?: string; run?: string; uses?: string; with?: { branch?: string } }> }
      }
    }
    const pullRequestPaths = images.on?.pull_request?.paths ?? []
    const pushPaths = images.on?.push?.paths ?? []
    const dependencies = ['packages/scripts/src/shared/cli.ts', 'packages/scripts/package.json', 'bun.lock']
    for (const dependency of dependencies) {
      expect(pullRequestPaths).toContain(dependency)
      expect(pushPaths).toContain(dependency)
    }
    for (const manifest of [
      'argocd/applications/tengri/kustomization.yaml',
      'argocd/applicationsets/platform.yaml',
      'argocd/applications/proompteng/deployment.yaml',
    ]) {
      expect(pushPaths).not.toContain(manifest)
    }

    const validationSteps = (release.jobs?.promote?.steps ?? []).filter((step) =>
      step.run?.includes('git diff --quiet'),
    )
    expect(validationSteps.length).toBe(3)
    for (const step of validationSteps) {
      for (const dependency of dependencies) expect(step.run).toContain(dependency)
    }
    const create = release.jobs?.promote?.steps?.find((step) =>
      step.uses?.startsWith('peter-evans/create-pull-request@'),
    )
    expect(release.concurrency?.group).toBe('tengri-release-promotion')
    expect(create?.with?.branch).toBe('codex/tengri-release')
  })

  it('refreshes release manifests and revalidates main immediately before creating the promotion PR', () => {
    const release = YAML.parse(readFileSync(releasePath, 'utf8')) as {
      jobs?: {
        promote?: { steps?: Array<{ name?: string; run?: string; uses?: string; with?: { 'add-paths'?: string } }> }
      }
    }
    const steps = release.jobs?.promote?.steps ?? []
    const refreshIndex = steps.findIndex((step) => step.name === 'Refresh promotion manifests from current main')
    const pinIndex = steps.findIndex((step) => step.name === 'Pin both images and enable Tengri')
    const revalidateIndex = steps.findIndex((step) => step.name === 'Revalidate current main before opening promotion')
    const createIndex = steps.findIndex((step) => step.uses?.startsWith('peter-evans/create-pull-request@'))

    expect(refreshIndex).toBeGreaterThan(-1)
    expect(refreshIndex).toBeLessThan(pinIndex)
    expect(steps[refreshIndex]?.run).toContain('argocd/applications/tengri/deployment.yaml')
    expect(pinIndex).toBeLessThan(revalidateIndex)
    expect(revalidateIndex).toBe(createIndex - 1)
    expect(steps[revalidateIndex]?.run).toContain('git fetch origin main')
    expect(steps[revalidateIndex]?.run).toContain('services/tengri')
    expect(steps[revalidateIndex]?.run).toContain('git checkout "$latest_main"')
    expect(steps[revalidateIndex]?.run).toContain('argocd/applications/tengri/deployment.yaml')
    expect(steps[revalidateIndex]?.run).toContain('argocd/applications/tengri/kustomization.yaml')
    expect(steps[revalidateIndex]?.run).toContain('argocd/applicationsets/platform.yaml')
    expect(steps[revalidateIndex]?.run).toContain('argocd/applications/proompteng/deployment.yaml')
    expect(steps[revalidateIndex]?.run).toContain('bun packages/scripts/src/tengri/update-release.ts')
    expect(steps[revalidateIndex]?.run).toContain('bun packages/scripts/src/tengri/validate-release.ts')
    expect(steps[createIndex]?.with?.['add-paths']).toContain('argocd/applications/proompteng/deployment.yaml')
  })
})
