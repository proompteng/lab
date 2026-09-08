import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const imagesPath = resolve(repositoryRoot, '.github/workflows/tengri-images.yml')
const controllerPath = resolve(repositoryRoot, '.github/workflows/tengri-controller.yaml')
const nanoagentDockerfilePath = resolve(repositoryRoot, 'services/nanoagent/Dockerfile')
const tengriDockerfilePath = resolve(repositoryRoot, 'services/tengri/Dockerfile')

describe('Tengri image workflow', () => {
  it('publishes signed multi-architecture images for Kargo discovery', () => {
    const source = readFileSync(imagesPath, 'utf8')
    const workflow = YAML.parse(source) as {
      jobs?: {
        publish?: { needs?: string[]; steps?: Array<{ name?: string; run?: string }> }
      }
    }

    expect(YAML.parse(source).name).toBe('Tengri images')
    expect(source).not.toContain('tengri-release.yml')
    expect(source).toContain('service: tengri')
    expect(source).toContain('service: nanoagent')
    expect(source).toContain('architecture: amd64')
    expect(source).toContain('architecture: arm64')
    expect(source).toContain('cosign sign --yes')
    expect(source).toContain("--format '{{json .Manifest}}'")
    expect(source).toContain("jq -er '.digest'")
    expect(source).toContain('org.opencontainers.image.created=${SOURCE_TIMESTAMP}')
    expect(source).toContain('org.opencontainers.image.revision=${SOURCE_SHA}')
    expect(source).toContain('crane mutate --platform "linux/${architecture}"')
    expect(source).toContain('crane config --platform "linux/${architecture}"')
    expect(source).toContain('--annotation "index:org.opencontainers.image.source=${SOURCE_URL}"')
    expect(source).toContain('--annotation "index:org.opencontainers.image.revision=${SOURCE_SHA}"')
    expect(source).toContain('.annotations["org.opencontainers.image.source"] == $source_url')
    expect(source).toContain('.annotations["org.opencontainers.image.revision"] == $source_sha')
    expect(source).toContain('kargo-sha-${SOURCE_SHA}')
    expect(source.match(/crane digest "\$\{kargo_reference\}"/g)).toHaveLength(2)
    expect(source).not.toMatch(
      /docker buildx imagetools inspect[\s\\]+--format '\{\{json \.Manifest\}\}'[\s\\]+"\$\{kargo_reference\}"/,
    )
    expect(source).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'")
    expect(source).not.toContain(':latest')
    expect(source).not.toContain('latest_digest')
    expect(source).not.toContain('sha256sum "${index_path}"')
    expect(source).not.toContain('release-contract.json')
    expect(workflow.jobs?.publish?.needs).toEqual(['build', 'validate-tengri', 'validate-nanoagent'])
    expect(existsSync(resolve(repositoryRoot, 'argocd/applications/kargo'))).toBe(true)
  })

  it('gates the publisher on full controller and guest validation', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs?: {
        'validate-tengri'?: { steps?: Array<{ run?: string }> }
        'validate-nanoagent'?: { steps?: Array<{ run?: string }> }
        publish?: { needs?: string[] }
      }
    }
    const controllerValidation = images.jobs?.['validate-tengri']?.steps?.map((step) => step.run ?? '').join('\n')
    const guestValidation = images.jobs?.['validate-nanoagent']?.steps?.map((step) => step.run ?? '').join('\n')

    expect(controllerValidation).toContain('cargo fmt --check')
    expect(controllerValidation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(controllerValidation).toContain('cargo test --locked --all-targets')
    expect(controllerValidation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
    expect(guestValidation).toContain('GOWORK=off go test -race ./...')
    expect(guestValidation).toContain('GOWORK=off go vet ./...')
    expect(images.jobs?.publish?.needs).toContain('validate-tengri')
    expect(images.jobs?.publish?.needs).toContain('validate-nanoagent')
  })

  it('keeps the controller workflow separate from image publication', () => {
    const source = readFileSync(controllerPath, 'utf8')

    expect(source).not.toContain('docker/build-push-action')
    expect(source).not.toContain('cosign sign')
  })

  it('uses the repository mirror instead of anonymous Docker Hub base pulls', () => {
    const nanoagent = readFileSync(nanoagentDockerfilePath, 'utf8')
    const tengri = readFileSync(tengriDockerfilePath, 'utf8')

    for (const dockerfile of [nanoagent, tengri]) {
      expect(dockerfile).toStartWith('# syntax=mirror.gcr.io/docker/dockerfile:1.7')
      expect(dockerfile).not.toContain('docker.io/')
    }
    expect(nanoagent).toContain('ARG GO_BASE_IMAGE=mirror.gcr.io/golang')
    expect(nanoagent).toContain('FROM ${GO_BASE_IMAGE}:${GO_VERSION}-bookworm AS go-runtime')
    expect(nanoagent).toContain('COPY --from=go-runtime /usr/local/go /bundle/go')
    expect(nanoagent).not.toContain('COPY --from=build /usr/local/go /bundle/go')
    expect(nanoagent).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(nanoagent).toContain('ARG NODE_BASE_IMAGE=mirror.gcr.io/node')
    expect(nanoagent).toContain('ARG UBUNTU_BASE_IMAGE=mirror.gcr.io/ubuntu')
    expect(nanoagent).toContain('ln -s /home/nanoagent/workspace /workspace')
    expect(nanoagent).toContain('bootstrap-toolchain --install-only')
    expect(nanoagent).toContain(
      'COPY --from=toolchain-smoke /tmp/toolchain-version /usr/share/nanoagent/toolchain-version',
    )
    expect(nanoagent).toContain('TOOLCHAIN_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-toolchain')
    expect(nanoagent).toContain('BUN_INSTALL=/home/nanoagent/.local')
    expect(nanoagent).toContain('NPM_CONFIG_PREFIX=/home/nanoagent/.local')
    expect(nanoagent).toContain('test "$(npm config get prefix)" = "$HOME/.local"')
    expect(nanoagent).toContain('test "$(bun pm bin --global)" = "$HOME/.local/bin"')
    expect(nanoagent).toContain('cargo new --quiet --lib /tmp/cargo-library-smoke')
    expect(nanoagent).toContain('(cd /tmp/cargo-library-smoke && cargo test --quiet)')
    expect(nanoagent).not.toContain('/bundle/rust/bin/rustdoc;')
    expect(nanoagent).toContain('ENTRYPOINT ["/usr/local/bin/nanoagent"]')
    expect(tengri).toContain('ARG DEBIAN_BASE_IMAGE=mirror.gcr.io/debian')
    expect(tengri).toContain('ARG RUST_BASE_IMAGE=mirror.gcr.io/rust')
  })

  it('removes the retired release-PR workflow', () => {
    expect(existsSync(resolve(repositoryRoot, '.github/workflows/tengri-release.yml'))).toBe(false)
  })
})
