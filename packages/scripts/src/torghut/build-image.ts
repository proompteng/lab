#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage, type DockerCacheMode } from '../shared/docker'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  platforms?: string[]
  codexAuthPath?: string
  cacheRef?: string
  cacheMode?: DockerCacheMode
}

const optionalEnvText = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  if (!normalized || normalized.toLowerCase() === 'none') return undefined
  return normalized
}

const optionalCacheMode = (value: string | undefined): DockerCacheMode | undefined => {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'max' || normalized === 'min') return normalized
  return undefined
}

let buildAndPushDockerImageImpl = buildAndPushDockerImage
let execGitImpl = execGit

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? 'lab/torghut'
  const tag = options.tag ?? process.env.TORGHUT_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? 'services/torghut')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? 'services/torghut/Dockerfile')
  const cacheRef = options.cacheRef ?? optionalEnvText(process.env.TORGHUT_IMAGE_CACHE_REF)
  const cacheMode = options.cacheMode ?? optionalCacheMode(process.env.TORGHUT_IMAGE_CACHE_MODE)
  const platformsEnv = process.env.TORGHUT_IMAGE_PLATFORMS
  const platforms =
    options.platforms ??
    (platformsEnv
      ? platformsEnv
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0 && p.toLowerCase() !== 'none')
      : ['linux/amd64', 'linux/arm64'])

  const version = execGitImpl(['describe', '--tags', '--always'])
  const commit = execGitImpl(['rev-parse', 'HEAD'])

  const result = await buildAndPushDockerImageImpl({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
    cacheRef,
    cacheMode,
    buildArgs: {
      TORGHUT_VERSION: version,
      TORGHUT_COMMIT: commit,
    },
  })

  return { ...result, version, commit }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  optionalEnvText,
  optionalCacheMode,
  setBuildAndPushDockerImage: (impl: typeof buildAndPushDockerImage = buildAndPushDockerImage) => {
    buildAndPushDockerImageImpl = impl
  },
  setExecGit: (impl: typeof execGit = execGit) => {
    execGitImpl = impl
  },
}
