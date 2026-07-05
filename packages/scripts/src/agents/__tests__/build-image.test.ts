import { afterEach, describe, expect, it } from 'bun:test'

import { __private, buildImage, buildImages } from '../build-image'
import type { BuildAndPushNixImageOptions } from '../../shared/nix-oci-deploy'

const originalEnv = { ...process.env }

const envKeys = [
  'AGENTS_COMMIT',
  'AGENTS_CONTROL_PLANE_IMAGE_REPOSITORY',
  'AGENTS_CONTROLLER_IMAGE_REPOSITORY',
  'AGENTS_IMAGE_REGISTRY',
  'AGENTS_IMAGE_REPOSITORY',
  'AGENTS_IMAGE_TAG',
  'AGENTS_IMAGE_TARGET',
  'AGENTS_DOCKER_TARGET',
  'AGENTS_NIX_IMAGE_TARGET',
  'AGENTS_RUNNER_IMAGE_REPOSITORY',
  'AGENTS_SHELL_IMAGE_REPOSITORY',
  'AGENTS_VERSION',
]

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
  __private.setBuildAndPushNixImage()
  __private.setExecGit()
})

describe('agents build-image helpers', () => {
  it('defaults to the Nix control-plane image target', () => {
    const config = __private.resolveBuildConfiguration({
      tag: 'abc123',
      commit: 'abcdef',
    })

    expect(config).toMatchObject({
      repository: 'lab/agents-control-plane',
      imageName: 'agents-control-plane',
      packageAttr: 'agents-control-plane-image',
      target: 'control-plane',
    })
  })

  it('maps all Agents image targets to concrete Nix package attrs', () => {
    expect(
      __private.resolveBuildConfiguration({
        target: 'controller',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/agents-controller',
      imageName: 'agents-controller',
      packageAttr: 'agents-controller-image',
    })
    expect(
      __private.resolveBuildConfiguration({
        target: 'agents-shell',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/agents-shell',
      imageName: 'agents-shell',
      packageAttr: 'agents-shell-image',
    })
    expect(
      __private.resolveBuildConfiguration({
        target: 'agents-codex-runner',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/agents-codex-runner',
      imageName: 'agents-codex-runner',
      packageAttr: 'agents-codex-runner-image',
      target: 'runner',
    })
  })

  it('honors generic repository overrides for explicit runner and shell targets', () => {
    process.env.AGENTS_IMAGE_REPOSITORY = 'lab/custom-agents-runtime'

    expect(
      __private.resolveBuildConfiguration({
        target: 'runner',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/custom-agents-runtime',
      target: 'runner',
      packageAttr: 'agents-codex-runner-image',
    })
    expect(
      __private.resolveBuildConfiguration({
        target: 'agents-shell',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/custom-agents-runtime',
      target: 'agents-shell',
      packageAttr: 'agents-shell-image',
    })
  })

  it('prefers target-specific repository overrides over the generic override', () => {
    process.env.AGENTS_IMAGE_REPOSITORY = 'lab/generic-agents-runtime'
    process.env.AGENTS_RUNNER_IMAGE_REPOSITORY = 'lab/custom-agents-runner'

    expect(
      __private.resolveBuildConfiguration({
        target: 'runner',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      repository: 'lab/custom-agents-runner',
      target: 'runner',
      packageAttr: 'agents-codex-runner-image',
    })
  })

  it('can infer the target from a canonical repository override', () => {
    expect(
      __private.resolveBuildConfiguration({
        repository: 'lab/agents-controller',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toMatchObject({
      target: 'controller',
      packageAttr: 'agents-controller-image',
    })
  })

  it('rejects the legacy Docker target env var instead of silently defaulting', () => {
    process.env.AGENTS_DOCKER_TARGET = 'controller'

    expect(() =>
      __private.resolveBuildConfiguration({
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toThrow('AGENTS_DOCKER_TARGET')
  })

  it('rejects old Docker-only build options instead of silently falling back', () => {
    expect(() =>
      __private.resolveBuildConfiguration({
        dockerfile: 'services/agents/Dockerfile',
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toThrow('Agents Nix image builds do not accept Docker-only option(s): dockerfile')

    expect(() =>
      __private.resolveBuildConfiguration({
        context: '.',
        cacheRef: 'registry.example/cache',
        platforms: ['linux/amd64'],
        tag: 'abc123',
        commit: 'abcdef',
      }),
    ).toThrow('context, cacheRef, platforms')
  })

  it('builds a single Agents image with the shared Nix OCI helper', async () => {
    const calls: BuildAndPushNixImageOptions[] = []
    __private.setBuildAndPushNixImage(async (options) => {
      calls.push(options)
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'missing-tag',
        digest: 'sha256:test',
        reference: `${options.registry}/${options.repository}@sha256:test`,
        sourceSha: options.sourceSha ?? 'missing-source',
        packageAttr: options.packageAttr,
        contractPath: options.contractPath ?? 'missing-contract',
        platforms: ['linux/amd64', 'linux/arm64'],
        platformDigests: {},
      }
    })

    const result = await buildImage({
      target: 'runner',
      tag: 'abc123',
      commit: 'abcdef',
      dryRun: true,
    })

    expect(calls).toEqual([
      {
        service: 'agents-codex-runner',
        imageName: 'agents-codex-runner',
        packageAttr: 'agents-codex-runner-image',
        registry: 'registry.ide-newton.ts.net',
        repository: 'lab/agents-codex-runner',
        tag: 'abc123',
        sourceSha: 'abcdef',
        latestTag: 'latest',
        dryRun: true,
        contractPath: '.artifacts/agents/agents-codex-runner-manual-release-contract.json',
      },
    ])
    expect(result).toMatchObject({
      image: 'registry.ide-newton.ts.net/lab/agents-codex-runner:abc123',
      digest: 'registry.ide-newton.ts.net/lab/agents-codex-runner@sha256:test',
      packageAttr: 'agents-codex-runner-image',
      target: 'runner',
    })
  })

  it('builds multiple Agents images through the Nix helper without Docker batching', async () => {
    const calls: BuildAndPushNixImageOptions[] = []
    __private.setBuildAndPushNixImage(async (options) => {
      calls.push(options)
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'missing-tag',
        digest: 'sha256:test',
        reference: `${options.registry}/${options.repository}@sha256:test`,
        sourceSha: options.sourceSha ?? 'missing-source',
        packageAttr: options.packageAttr,
        contractPath: options.contractPath ?? 'missing-contract',
        platforms: ['linux/amd64', 'linux/arm64'],
        platformDigests: {},
      }
    })

    const results = await buildImages([
      { target: 'controller', tag: 'abc123', commit: 'abcdef' },
      { target: 'control-plane', tag: 'abc123', commit: 'abcdef' },
      { target: 'agents-shell', tag: 'abc123', commit: 'abcdef' },
    ])

    expect(calls.map((call) => call.packageAttr)).toEqual([
      'agents-controller-image',
      'agents-control-plane-image',
      'agents-shell-image',
    ])
    expect(results.map((result) => result.image)).toEqual([
      'registry.ide-newton.ts.net/lab/agents-controller:abc123',
      'registry.ide-newton.ts.net/lab/agents-control-plane:abc123',
      'registry.ide-newton.ts.net/lab/agents-shell:abc123',
    ])
  })

  it('parses removed Docker CLI flags so Nix option rejection catches them', () => {
    const options = __private.parseArgs([
      '--dockerfile',
      'services/agents/Dockerfile',
      '--context=.',
      '--cache-ref',
      'registry.example/cache',
      '--platforms=linux/amd64,linux/arm64',
      '--target',
      'runner',
      '--tag',
      'abc123',
    ])

    expect(options).toEqual({
      dockerfile: 'services/agents/Dockerfile',
      context: '.',
      cacheRef: 'registry.example/cache',
      platforms: ['linux/amd64', 'linux/arm64'],
      target: 'runner',
      tag: 'abc123',
    })
    expect(() => __private.resolveBuildConfiguration({ ...options, commit: 'abcdef' })).toThrow(
      'Docker-only option(s): context, dockerfile, cacheRef, platforms',
    )
  })

  it('rejects unknown or malformed manual CLI flags before they can be consumed as tags', () => {
    expect(() => __private.parseArgs(['--unknown'])).toThrow('Unsupported Agents build-image CLI flag: --unknown')
    expect(() => __private.parseArgs(['--target'])).toThrow('Missing value for --target')
    expect(() => __private.parseArgs(['abc123', 'extra'])).toThrow('Unexpected positional argument: extra')
  })

  it('parses the manual CLI target, tag, repository, registry, and dry-run flags', () => {
    expect(
      __private.parseArgs([
        '--target',
        'runner',
        '--tag=abc123',
        '--repository',
        'lab/agents-codex-runner',
        '--registry=registry.ide-newton.ts.net',
        '--dry-run',
      ]),
    ).toEqual({
      target: 'runner',
      tag: 'abc123',
      repository: 'lab/agents-codex-runner',
      registry: 'registry.ide-newton.ts.net',
      dryRun: true,
    })
  })
})
