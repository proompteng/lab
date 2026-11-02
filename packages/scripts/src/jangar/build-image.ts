#!/usr/bin/env bun

import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  target?: string
  version?: string
  commit?: string
  codexAuthPath?: string
  cacheRef?: string
  platforms?: string[]
  cacheMode?: string
  dryRun?: boolean
}

const dockerOnlyEnvNames = [
  'JANGAR_BUILD_CONTEXT',
  'JANGAR_DOCKERFILE',
  'JANGAR_DOCKER_TARGET',
  'JANGAR_BUILD_CACHE_REF',
  'JANGAR_BUILD_CACHE_MODE',
  'JANGAR_IMAGE_PLATFORMS',
  'DOCKER_IMAGE_PLATFORMS',
  'DOCKER_BUILD_PROVENANCE',
  'DOCKER_BUILD_SBOM',
]

const rejectDockerOnlyOptions = (options: BuildImageOptions) => {
  const optionNames = [
    ['context', options.context],
    ['dockerfile', options.dockerfile],
    ['target', options.target],
    ['codexAuthPath', options.codexAuthPath],
    ['cacheRef', options.cacheRef],
    ['platforms', options.platforms],
    ['cacheMode', options.cacheMode],
  ] as const

  const providedOptions = optionNames.filter(([, value]) => value !== undefined).map(([name]) => name)
  const providedEnv = dockerOnlyEnvNames.filter((name) => process.env[name]?.trim())
  if (providedOptions.length > 0 || providedEnv.length > 0) {
    throw new Error(
      `Jangar image builds are Nix OCI only; remove Docker-only inputs: ${[...providedOptions, ...providedEnv].join(', ')}`,
    )
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  rejectDockerOnlyOptions(options)

  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const commit = options.commit ?? process.env.JANGAR_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const version = options.version ?? process.env.JANGAR_VERSION ?? tag

  const result = await buildAndPushNixImage({
    service: 'jangar',
    imageName: 'jangar',
    packageAttr: 'jangar-image',
    registry,
    repository,
    tag,
    sourceSha: commit,
    latestTag: 'latest',
    dryRun: options.dryRun,
  })

  return { image: `${registry}/${repository}:${tag}`, digest: result.reference, version, commit }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cliTag = args[0]?.trim() && !args[0]?.startsWith('-') ? args[0] : undefined
  buildImage({ tag: cliTag, dryRun: args.includes('--dry-run') }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  rejectDockerOnlyOptions,
}
